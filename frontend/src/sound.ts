import type { NodeState, Wave } from '../../shared/types.ts';
import type { WavePlan } from './stats.ts';

/**
 * The health wall as sound. Every finished round becomes a SoundRound (who got the block, when in the
 * wall's replay, where on the map); a sound turns that into notes. Everything is synthesised with Web
 * Audio, nothing is loaded. The page may only make sound after a click, so the player starts on demand.
 */

export const SOUNDS = ['droplets', 'kalimba', 'glass', 'techno', 'symphony'] as const;
export type SoundName = (typeof SOUNDS)[number];
export const SOUND_LABELS: Record<SoundName, string> = {
  droplets: 'DROPLETS',
  kalimba: 'KALIMBA',
  glass: 'GLASS',
  techno: 'TECHNO',
  symphony: 'SYMPHONY',
};
/**
 * Droplets, kalimba and symphony sound the moment a round arrives, in step with the wall's flashes.
 * Glass and techno are rhythmic, so they keep their own steady bar (one bar per block time) and pick up
 * the newest round at each bar line: an uneven round arrival must not bend the beat.
 */
const ON_BAR: Record<SoundName, boolean> = {
  droplets: false,
  kalimba: false,
  glass: true,
  techno: true,
  symphony: false,
};

export type Region = 'eu' | 'na' | 'as' | 'other';
export const regionOf = (lat: number, lng: number): Region =>
  lng < -30 ? 'na' : lng > 45 ? 'as' : lat > 34 ? 'eu' : 'other';

export interface SoundHit {
  /** Seconds into the replay at which the wall flashes this node */
  at: number;
  /** -1 left .. 1 right, from the node's longitude */
  pan: number;
  /** Place on the wall, 0 = first hex (fastest reply) */
  rank: number;
  region: Region;
}

export interface SoundRound {
  round: number;
  /** Ascending by `at` */
  hits: SoundHit[];
  /** Part of the world of the node that had the block first */
  origin: Region;
  /** How many nodes the wall holds, for scaling ranks */
  nodes: number;
}

/** What a round sounds from: the same delays and replay clock the wall's flashes use. */
export function soundRound(
  wave: Wave,
  plan: WavePlan,
  nodes: NodeState[],
  order: Map<string, number>,
): SoundRound {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hits: SoundHit[] = [];
  for (const [id, delay] of Object.entries(wave.delays)) {
    const n = byId.get(id);
    if (!n) continue;
    hits.push({
      at: plan.at(delay) / 1000,
      pan: Math.max(-1, Math.min(1, n.lng / 180)),
      rank: order.get(id) ?? 0,
      region: regionOf(n.lat, n.lng),
    });
  }
  hits.sort((a, b) => a.at - b.at);
  const first = byId.get(wave.origin);
  return {
    round: wave.round,
    hits,
    origin: first ? regionOf(first.lat, first.lng) : 'other',
    nodes: Math.max(1, nodes.length),
  };
}

/** Arrivals per sixteenth of a bar; whatever lands after the bar counts in its last step. */
export function steps(hits: SoundHit[], bar: number): number[] {
  const out = Array.from({ length: 16 }, () => 0);
  for (const h of hits) out[Math.max(0, Math.min(15, Math.floor((h.at / bar) * 16)))]!++;
  return out;
}

/** When a share of a region's nodes (or of all, without a region) has the block, seconds; null if none. */
export function reach(hits: SoundHit[], share: number, region?: Region): number | null {
  const group = region ? hits.filter((h) => h.region === region) : hits;
  return group.length ? group[Math.min(group.length - 1, Math.floor(group.length * share))]!.at : null;
}

// ─── synthesis ────────────────────────────────────────────────────────────────

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const PENTATONIC = [0, 2, 4, 7, 9];
const penta = (i: number, base: number) => base + 12 * Math.floor(i / 5) + PENTATONIC[i % 5]!;
/** One chord per round, four rounds to come home: i, VI, III, VII (glass) and I, vi, IV, V (symphony) */
const GLASS_CHORDS = [
  [57, 60, 64, 69],
  [53, 57, 60, 65],
  [48, 55, 60, 64],
  [55, 59, 62, 67],
];
const SYMPHONY_CHORDS = [
  [48, 52, 55],
  [45, 48, 52],
  [41, 45, 48],
  [43, 47, 50],
];

interface NoteOpts {
  type?: OscillatorType;
  /** Start the pitch at this multiple of the note and glide to it: drops and drum skins */
  from?: number;
  glide?: number;
  gain?: number;
  attack?: number;
  decay?: number;
  lowpass?: number;
  q?: number;
  pan?: number;
  wet?: number;
}

/** One round's or bar's voices share two buses, so they can be faded out together. */
interface Bus {
  t0: number;
  dry: GainNode;
  wet: GainNode;
}

export class SoundPlayer {
  private ac?: AudioContext;
  private master?: GainNode;
  private room?: ConvolverNode;
  private noise?: AudioBuffer;
  private volume = 0.75;
  private name?: SoundName;
  private live: Bus[] = [];
  /** Bar clock for the rhythmic sounds */
  private bar = 2.8;
  private nextBar = 0;
  private barCount = 0;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: SoundRound;

  get playing(): SoundName | undefined {
    return this.name;
  }

  /** Must be called from a click: browsers only then allow sound. */
  start(name: SoundName): void {
    this.boot();
    void this.ac!.resume();
    this.hush();
    this.name = name;
    this.pending = undefined;
    clearInterval(this.timer);
    if (ON_BAR[name]) {
      this.nextBar = this.ac!.currentTime + 0.1;
      this.barCount = 0;
      this.timer = setInterval(() => this.tick(), 60);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.name = undefined;
    this.pending = undefined;
    if (this.ac) this.hush();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ac && this.master) this.master.gain.setTargetAtTime(v, this.ac.currentTime, 0.02);
  }

  /** A finished round, at the moment the wall starts flashing it. `blockTime` in seconds sets the bar. */
  feed(round: SoundRound, blockTime: number): void {
    if (!this.name || !this.ac) return;
    if (blockTime > 0) this.bar = Math.max(2.2, Math.min(3.6, blockTime));
    if (ON_BAR[this.name]) {
      this.pending = round;
      return;
    }
    const bus = this.bus(this.ac.currentTime + 0.03);
    if (this.name === 'droplets') this.droplets(bus, round);
    else if (this.name === 'kalimba') this.kalimba(bus, round);
    else this.symphony(bus, round);
  }

  // ─── engine ───────────────────────────────────────────────────────────────

  private boot(): void {
    if (this.ac) return;
    const ac = new AudioContext();
    this.ac = ac;
    this.master = ac.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ac.createDynamicsCompressor()).connect(ac.destination);
    // a generated room: decaying noise
    const length = Math.floor(ac.sampleRate * 2.6);
    const impulse = ac.createBuffer(2, length, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6;
    }
    this.room = ac.createConvolver();
    this.room.buffer = impulse;
    this.room.connect(this.master);
    this.noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  private bus(t0: number): Bus {
    const ac = this.ac!;
    const b: Bus = { t0, dry: ac.createGain(), wet: ac.createGain() };
    b.dry.connect(this.master!);
    b.wet.connect(this.room!);
    this.live.push(b);
    while (this.live.length > 4) {
      const old = this.live.shift()!;
      old.dry.disconnect();
      old.wet.disconnect();
    }
    return b;
  }

  private hush(): void {
    const now = this.ac!.currentTime;
    for (const b of this.live) {
      for (const g of [b.dry, b.wet]) {
        g.gain.cancelScheduledValues(now);
        g.gain.setTargetAtTime(0, now, 0.03);
      }
    }
    this.live = [];
  }

  private tick(): void {
    const ac = this.ac!;
    if (!this.name || ac.currentTime < this.nextBar - 0.25) return;
    const bus = this.bus(this.nextBar);
    const round = this.pending;
    this.pending = undefined;
    if (this.name === 'glass') this.glass(bus, round);
    else this.techno(bus, round);
    this.barCount++;
    // if the tab slept, start again from now instead of racing through the missed bars
    this.nextBar = Math.max(this.nextBar + this.bar, ac.currentTime + 0.05);
  }

  private sink(b: Bus, pan = 0, wet = 0.2): AudioNode {
    const ac = this.ac!;
    const p = ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(b.dry);
    if (wet > 0) {
      const send = ac.createGain();
      send.gain.value = wet;
      p.connect(send).connect(b.wet);
    }
    return p;
  }

  private envelope(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private note(b: Bus, t: number, freq: number, o: NoteOpts = {}): void {
    const ac = this.ac!;
    const attack = o.attack ?? 0.004;
    const decay = o.decay ?? 0.3;
    const osc = ac.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq * (o.from ?? 1), t);
    if (o.from) osc.frequency.exponentialRampToValueAtTime(freq, t + (o.glide ?? 0.05));
    const g = ac.createGain();
    this.envelope(g, t, o.gain ?? 0.15, attack, decay);
    let head: AudioNode = osc;
    if (o.lowpass) {
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lowpass;
      lp.Q.value = o.q ?? 0.7;
      head = osc.connect(lp);
    }
    head.connect(g).connect(this.sink(b, o.pan, o.wet));
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  /** A burst of filtered noise: the splash of a drop, hats, a clap, a drum skin */
  private hiss(
    b: Bus,
    t: number,
    o: {
      band?: BiquadFilterType;
      freq: number;
      q?: number;
      gain: number;
      decay: number;
      pan?: number;
      wet?: number;
    },
  ): void {
    const ac = this.ac!;
    const src = ac.createBufferSource();
    src.buffer = this.noise!;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = o.band ?? 'highpass';
    f.frequency.value = o.freq;
    f.Q.value = o.q ?? 0.8;
    const g = ac.createGain();
    this.envelope(g, t, o.gain, 0.001, o.decay);
    src
      .connect(f)
      .connect(g)
      .connect(this.sink(b, o.pan, o.wet ?? 0.1));
    src.start(t, Math.random() * 0.5);
    src.stop(t + o.decay + 0.06);
  }

  /** A held chord whose loudness follows [time, level] points and dies away after `until` */
  private swell(
    b: Bus,
    freqs: number[],
    points: [number, number][],
    until: number,
    o: { type: OscillatorType; gain: number; lowpass: number; pan: number; wet?: number; solo?: boolean },
  ): void {
    const ac = this.ac!;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, b.t0);
    for (const [t, level] of points) g.gain.linearRampToValueAtTime(Math.max(0.0001, level * o.gain), t);
    g.gain.linearRampToValueAtTime(0.0001, until + 0.5);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = o.lowpass;
    lp.connect(g).connect(this.sink(b, o.pan, o.wet ?? 0.4));
    for (const f of freqs) {
      for (const detune of o.solo ? [0] : [-6, 6]) {
        const osc = ac.createOscillator();
        osc.type = o.type;
        osc.frequency.value = f;
        osc.detune.value = detune;
        osc.connect(lp);
        osc.start(b.t0);
        osc.stop(until + 0.6);
      }
    }
  }

  // ─── the sounds ───────────────────────────────────────────────────────────

  /** One drop per node at its flash: faster-answering nodes are smaller, higher drops; the first is a plop */
  private droplets(b: Bus, r: SoundRound): void {
    for (const h of r.hits) {
      const freq = 2300 - (h.rank / r.nodes) * 1700;
      this.note(b, b.t0 + h.at, freq * 1.5, {
        from: 0.62,
        glide: 0.035,
        gain: 0.1,
        decay: 0.11,
        pan: h.pan,
        wet: 0.45,
      });
      this.hiss(b, b.t0 + h.at, { freq: 4500, gain: 0.012, decay: 0.02, pan: h.pan });
    }
    this.note(b, b.t0, 320, { from: 0.5, glide: 0.07, gain: 0.3, decay: 0.4, wet: 0.5 });
  }

  /** Each node plucks its own note of a five-note scale, softer the later it gets the block */
  private kalimba(b: Bus, r: SoundRound): void {
    const last = r.hits[r.hits.length - 1]?.at || 1;
    for (const h of r.hits) {
      const freq = hz(penta(h.rank % 15, 60));
      const gain = 0.14 * (1 - 0.6 * (h.at / last));
      this.note(b, b.t0 + h.at, freq, { type: 'triangle', gain, decay: 0.9, pan: h.pan, wet: 0.35 });
      this.note(b, b.t0 + h.at, freq * 2, { gain: gain * 0.35, decay: 0.25, pan: h.pan, wet: 0.2 });
    }
  }

  /** Sixteen steps a bar: a step sounds only if nodes got the block in it, louder when more did */
  private glass(b: Bus, r: SoundRound | undefined): void {
    const chord = GLASS_CHORDS[this.barCount % 4]!;
    const step = this.bar / 16;
    this.note(b, b.t0, hz(chord[0]! - 24), { type: 'triangle', gain: 0.25, decay: 1.6, wet: 0.1 });
    if (!r) return;
    const counts = steps(r.hits, this.bar);
    const most = Math.max(1, ...counts);
    counts.forEach((count, s) => {
      if (!count) return;
      const midi = chord[s % 4]! + 12 * Math.floor((s % 8) / 4) + 12;
      this.note(b, b.t0 + s * step, hz(midi), {
        type: 'triangle',
        gain: 0.05 + 0.13 * (count / most),
        decay: 0.22,
        pan: s % 2 ? 0.4 : -0.4,
        wet: 0.3,
      });
    });
  }

  /** Fixed kick and clap at block tempo; hats from the arrivals; the bass filter opens as the block spreads */
  private techno(b: Bus, r: SoundRound | undefined): void {
    const step = this.bar / 16;
    const counts = r ? steps(r.hits, this.bar) : undefined;
    const most = Math.max(1, ...(counts ?? [1]));
    const total = r?.hits.length || 1;
    const root = { eu: 33, na: 36, as: 38, other: 40 }[r?.origin ?? 'eu'];
    let arrived = 0;
    for (let s = 0; s < 16; s++) {
      const t = b.t0 + s * step;
      arrived += counts?.[s] ?? 0;
      if (s % 4 === 0) this.note(b, t, 46, { from: 3.2, glide: 0.09, gain: 0.7, decay: 0.26, wet: 0 });
      if (s % 8 === 4) {
        this.hiss(b, t, { band: 'bandpass', freq: 1800, q: 0.9, gain: 0.22, decay: 0.12, wet: 0.25 });
      }
      if (counts?.[s]) {
        const gain = 0.03 + 0.1 * (counts[s]! / most);
        this.hiss(b, t, { freq: 8000, gain, decay: 0.035, pan: s % 2 ? 0.3 : -0.3 });
      }
      if (s % 4 !== 0) {
        this.note(b, t, hz(root + (s % 8 === 6 ? 12 : 0)), {
          type: 'sawtooth',
          gain: 0.16,
          decay: 0.13,
          lowpass: 180 + 2600 * (arrived / total),
          q: 9,
          wet: 0.05,
        });
      }
    }
  }

  /**
   * Strings for Europe, brass for North America, woodwinds for Asia-Pacific: each section swells as its
   * own nodes get the block. Timpani marks the round and a harp figure starts in the first node's section.
   */
  private symphony(b: Bus, r: SoundRound): void {
    const chord = SYMPHONY_CHORDS[r.round % 4]!;
    const until = b.t0 + this.bar;
    const points = (region: Region): [number, number][] =>
      [0.25, 0.5, 0.75, 0.95].flatMap((share, j): [number, number][] => {
        const at = reach(r.hits, share, region);
        return at === null ? [] : [[b.t0 + Math.max(0.05, at), (j + 1) / 4]];
      });
    const strings = [...chord.map((m) => hz(m + 12)), hz(chord[0]! + 24)];
    this.swell(b, strings, points('eu'), until, { type: 'sawtooth', gain: 0.045, lowpass: 2200, pan: -0.35 });
    this.swell(b, [hz(chord[0]!), hz(chord[2]!)], points('na'), until, {
      type: 'square',
      gain: 0.07,
      lowpass: 750,
      pan: 0.4,
      wet: 0.3,
    });
    this.swell(b, [hz(chord[1]! + 24), hz(chord[2]! + 24)], points('as'), until, {
      type: 'triangle',
      gain: 0.12,
      lowpass: 3000,
      pan: 0.1,
      solo: true,
    });
    this.note(b, b.t0, 62, { from: 1.5, glide: 0.12, gain: 0.5, decay: 0.9, wet: 0.5 });
    this.hiss(b, b.t0, { band: 'lowpass', freq: 300, gain: 0.25, decay: 0.3, wet: 0.4 });
    const pan = { eu: -0.35, na: 0.4, as: 0.1, other: 0 }[r.origin];
    [0, 1, 2, 0].forEach((j, s) => {
      const midi = chord[j]! + 24 + (s === 3 ? 12 : 0);
      this.note(b, b.t0 + 0.15 + s * 0.11, hz(midi), {
        type: 'triangle',
        gain: 0.1,
        decay: 0.8,
        pan,
        wet: 0.45,
      });
    });
  }
}
