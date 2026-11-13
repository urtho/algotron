import type { NodeState, Wave } from '../../shared/types.ts';
import type { WavePlan } from './stats.ts';

/**
 * The health wall as sound. Every finished round becomes a SoundRound (who got the block, when in the
 * wall's replay, where on the map); a sound turns that into notes. Everything is synthesised with Web
 * Audio, nothing is loaded. The page may only make sound after a click, so the player starts on demand.
 */

export const SOUNDS = ['droplets', 'kalimba', 'glass', 'techno', 'acid'] as const;
export type SoundName = (typeof SOUNDS)[number];
export const SOUND_LABELS: Record<SoundName, string> = {
  droplets: 'DROPLETS',
  kalimba: 'KALIMBA',
  glass: 'GLASS',
  techno: 'TECHNO',
  acid: 'ACID',
};
/**
 * Droplets and kalimba sound the moment a round arrives, in step with the wall's flashes. The others are
 * rhythmic, so they keep their own steady bar (one bar per block time) and pick up the newest round at
 * each bar line: an uneven round arrival must not bend the beat.
 */
const ON_BAR = new Set<SoundName>(['glass', 'techno', 'acid']);
/**
 * Acid's bar is 24 steps, four to a beat: six beats a block, about 131 BPM at a 2.75 s block. Its echo
 * comes three steps later and feeds this much of itself back.
 */
const ACID_STEPS = 24;
const ACID_ECHO = 3 / ACID_STEPS;
const ACID_FEEDBACK = 0.4;
/** At most this many kalimba plucks ring at once */
const KALIMBA_VOICES = 5;

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

const stepOf = (at: number, bar: number, n: number) =>
  Math.max(0, Math.min(n - 1, Math.floor((at / bar) * n)));

/** Arrivals per step of a bar, sixteen unless told otherwise; whatever lands after the bar counts in its last step. */
export function steps(hits: SoundHit[], bar: number, n = 16): number[] {
  const out = Array.from({ length: n }, () => 0);
  for (const h of hits) out[stepOf(h.at, bar, n)]!++;
  return out;
}

// ─── synthesis ────────────────────────────────────────────────────────────────

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const PENTATONIC = [0, 2, 4, 7, 9];
const penta = (i: number, base: number) => base + 12 * Math.floor(i / 5) + PENTATONIC[i % 5]!;
/** One chord per round, four rounds to come home: i, VI, III, VII */
const GLASS_CHORDS = [
  [57, 60, 64, 69],
  [53, 57, 60, 65],
  [48, 55, 60, 64],
  [55, 59, 62, 67],
];
/** Techno's key follows the part of the world that had the block first: A, C, D, E */
const ROOTS: Record<Region, number> = { eu: 33, na: 36, as: 38, other: 40 };
/** Acid: the notes a step can pick, semitones over the root */
const ACID = [0, 12, 3, 0, 7, 10, 0, 15];

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
  /** Where the note goes instead of straight to the bus: a duck, a drive, a pluck's own gain */
  to?: AudioNode;
}

/** One round's or bar's voices share three buses (dry, room, echo), so they can be faded out together. */
interface Bus {
  t0: number;
  dry: GainNode;
  wet: GainNode;
  echo: GainNode;
}

export class SoundPlayer {
  private ac?: AudioContext;
  private master?: GainNode;
  private room?: ConvolverNode;
  private noise?: AudioBuffer;
  /** A tempo-synced echo: the delay, what it feeds back and what it returns */
  private echo?: DelayNode;
  private feedback?: GainNode;
  private echoOut?: GainNode;
  private volume = 0.75;
  private name?: SoundName;
  private live: Bus[] = [];
  /** Bar clock for the rhythmic sounds */
  private bar = 2.8;
  private nextBar = 0;
  private barCount = 0;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: SoundRound;
  /** Acid: the last round and the bars since it came */
  private last?: SoundRound;
  private idle = 0;
  /** Kalimba plucks still ringing, oldest first */
  private plucks: { from: number; until: number; choke: GainNode }[] = [];

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
    this.last = undefined;
    this.idle = 0;
    // let the previous sound's echo run out unheard, then open it for this one
    const now = this.ac!.currentTime;
    for (const [g, v] of [
      [this.feedback!, name === 'acid' ? ACID_FEEDBACK : 0],
      [this.echoOut!, 1],
    ] as const) {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(0, now);
      g.gain.setValueAtTime(v, now + 0.5);
    }
    clearInterval(this.timer);
    if (ON_BAR.has(name)) {
      this.nextBar = now + 0.1;
      this.barCount = 0;
      this.timer = setInterval(() => this.tick(), 60);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.name = undefined;
    this.pending = undefined;
    if (!this.ac) return;
    this.hush();
    this.echoOut!.gain.cancelScheduledValues(this.ac.currentTime);
    this.echoOut!.gain.setTargetAtTime(0, this.ac.currentTime, 0.03);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ac && this.master) this.master.gain.setTargetAtTime(v, this.ac.currentTime, 0.02);
  }

  /** A finished round, at the moment the wall starts flashing it. `blockTime` in seconds sets the bar. */
  feed(round: SoundRound, blockTime: number): void {
    if (!this.name || !this.ac) return;
    if (blockTime > 0) this.bar = Math.max(2.2, Math.min(3.6, blockTime));
    if (ON_BAR.has(this.name)) {
      this.pending = round;
      return;
    }
    const bus = this.bus(this.ac.currentTime + 0.03);
    if (this.name === 'droplets') this.droplets(bus, round);
    else this.kalimba(bus, round);
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
    // the echo loses its lows and highs on every pass
    this.echo = ac.createDelay(1);
    this.feedback = ac.createGain();
    this.echoOut = ac.createGain();
    const tone = ac.createBiquadFilter();
    tone.type = 'bandpass';
    tone.frequency.value = 1100;
    tone.Q.value = 0.5;
    this.echo.connect(tone);
    tone.connect(this.feedback).connect(this.echo);
    tone.connect(this.echoOut).connect(this.master);
    this.noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  private bus(t0: number): Bus {
    const ac = this.ac!;
    const b: Bus = { t0, dry: ac.createGain(), wet: ac.createGain(), echo: ac.createGain() };
    b.dry.connect(this.master!);
    b.wet.connect(this.room!);
    b.echo.connect(this.echo!);
    this.live.push(b);
    while (this.live.length > 4) {
      const old = this.live.shift()!;
      old.dry.disconnect();
      old.wet.disconnect();
      old.echo.disconnect();
    }
    return b;
  }

  private hush(): void {
    const now = this.ac!.currentTime;
    for (const b of this.live) {
      for (const g of [b.dry, b.wet, b.echo]) {
        g.gain.cancelScheduledValues(now);
        g.gain.setTargetAtTime(0, now, 0.03);
      }
    }
    this.live = [];
    this.plucks = [];
  }

  private tick(): void {
    const ac = this.ac!;
    if (!this.name || ac.currentTime < this.nextBar - 0.25) return;
    const bus = this.bus(this.nextBar);
    const fresh = this.pending;
    this.pending = undefined;
    if (this.name === 'glass') this.glass(bus, fresh);
    else if (this.name === 'techno') this.techno(bus, fresh);
    else {
      if (fresh) {
        this.last = fresh;
        this.idle = 0;
      } else this.idle++;
      this.echo!.delayTime.setTargetAtTime(this.bar * ACID_ECHO, bus.t0, 0.02);
      // a round that misses the bar line by a moment plays the last one again; two empty bars are a stall
      this.acid(bus, fresh ?? (this.idle < 2 ? this.last : undefined));
    }
    this.barCount++;
    // if the tab slept, start again from now instead of racing through the missed bars
    this.nextBar = Math.max(this.nextBar + this.bar, ac.currentTime + 0.05);
  }

  private sink(b: Bus, pan = 0, wet = 0.2, echo = 0): AudioNode {
    const ac = this.ac!;
    const p = ac.createStereoPanner();
    p.pan.value = clamp(pan);
    p.connect(b.dry);
    for (const [amount, to] of [
      [wet, b.wet],
      [echo, b.echo],
    ] as const) {
      if (amount <= 0) continue;
      const send = ac.createGain();
      send.gain.value = amount;
      p.connect(send).connect(to);
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
    head.connect(g).connect(o.to ?? this.sink(b, o.pan, o.wet));
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
      to?: AudioNode;
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
      .connect(o.to ?? this.sink(b, o.pan, o.wet ?? 0.1));
    src.start(t, Math.random() * 0.5);
    src.stop(t + o.decay + 0.06);
  }

  // ─── acid's kit ───────────────────────────────────────────────────────────

  /** Soft saturation in front of the bus: what goes in comes out fatter and never above `level` */
  private drive(b: Bus, amount: number, level: number, wet = 0, echo = 0): AudioNode {
    const ac = this.ac!;
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(amount * ((i / (curve.length - 1)) * 2 - 1));
    const shaper = ac.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = '2x';
    const out = ac.createGain();
    out.gain.value = level;
    shaper.connect(out).connect(this.sink(b, 0, wet, echo));
    return shaper;
  }

  /** A gain the kicks push down, so what plays through it pumps with them */
  private duck(kicks: number[], to: AudioNode, floor = 0.25, release = 0.22): AudioNode {
    const g = this.ac!.createGain();
    for (const t of kicks) {
      g.gain.setValueAtTime(floor, t);
      g.gain.linearRampToValueAtTime(1, t + release);
    }
    g.connect(to);
    return g;
  }

  /** A kick with a skin and a click on top of the body */
  private kick(b: Bus, t: number, gain = 0.8, to?: AudioNode): void {
    this.note(b, t, 48, { from: 4, glide: 0.07, gain, decay: 0.3, wet: 0, to });
    this.note(b, t, 170, {
      type: 'triangle',
      from: 2,
      glide: 0.015,
      gain: gain * 0.3,
      decay: 0.035,
      wet: 0,
      to,
    });
    this.hiss(b, t, { freq: 3000, gain: gain * 0.1, decay: 0.01, wet: 0, to });
  }

  /** Three quick bursts and a tail, like hands that do not land together */
  private clap(b: Bus, t: number, gain: number): void {
    for (const late of [0, 0.011, 0.023]) {
      this.hiss(b, t + late, {
        band: 'bandpass',
        freq: 1500,
        q: 1.2,
        gain: gain * 0.7,
        decay: 0.012,
        wet: 0.2,
      });
    }
    this.hiss(b, t + 0.03, { band: 'bandpass', freq: 1300, q: 0.8, gain, decay: 0.16, wet: 0.3 });
  }

  private hat(b: Bus, t: number, gain: number, o: { open?: boolean; pan?: number } = {}): void {
    this.hiss(b, t, {
      freq: o.open ? 6500 : 8000,
      gain,
      decay: o.open ? 0.16 : 0.035,
      pan: o.pan,
      wet: o.open ? 0.15 : 0.1,
    });
  }

  /** A 303-like note: a saw through a ringing low-pass that snaps open and falls back; it can slide in */
  private squelch(
    t: number,
    midi: number,
    o: {
      to: AudioNode;
      length: number;
      cutoff: number;
      sweep: number;
      q?: number;
      gain?: number;
      accent?: boolean;
      from?: number;
    },
  ): void {
    const ac = this.ac!;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(hz(o.from ?? midi), t);
    if (o.from !== undefined) osc.frequency.exponentialRampToValueAtTime(hz(midi), t + 0.06);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = o.q ?? 9;
    lp.frequency.setValueAtTime(Math.min(12000, o.cutoff + o.sweep * (o.accent ? 1.6 : 1)), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(60, o.cutoff), t + o.length * (o.accent ? 1.2 : 0.8));
    const g = ac.createGain();
    this.envelope(g, t, (o.gain ?? 0.16) * (o.accent ? 1.5 : 1), 0.003, o.length);
    osc.connect(lp).connect(g).connect(o.to);
    osc.start(t);
    osc.stop(t + o.length + 0.06);
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

  /**
   * Each node plucks its own note of a five-note scale, softer the later it gets the block. Only
   * KALIMBA_VOICES plucks ring at once: a new one cuts the oldest short, and is left out when even the
   * oldest has only just begun.
   */
  private kalimba(b: Bus, r: SoundRound): void {
    const last = r.hits[r.hits.length - 1]?.at || 1;
    for (const h of r.hits) {
      const t = b.t0 + h.at;
      this.plucks = this.plucks.filter((p) => p.until > t);
      if (this.plucks.length >= KALIMBA_VOICES) {
        const oldest = this.plucks[0]!;
        if (t - oldest.from < 0.06) continue;
        oldest.choke.gain.setTargetAtTime(0, t, 0.012);
        this.plucks.shift();
      }
      const choke = this.ac!.createGain();
      choke.connect(this.sink(b, h.pan, 0.3));
      this.plucks.push({ from: t, until: t + 0.9, choke });
      const freq = hz(penta(h.rank % 15, 60));
      const gain = 0.14 * (1 - 0.6 * (h.at / last));
      this.note(b, t, freq, { type: 'triangle', gain, decay: 0.9, to: choke });
      this.note(b, t, freq * 2, { gain: gain * 0.35, decay: 0.25, to: choke });
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
    const root = ROOTS[r?.origin ?? 'eu'];
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
   * Six beats a block: a driven kick, a clap and an open hat off the beat under a 303 line that the round
   * writes. A step with arrivals picks its note from how many came, a busy step is accented, arrivals in
   * neighbouring steps slide into each other. The filter opens with the spread and rides a slow wave of
   * eight blocks. Hats come from the arrivals and the key from where the block was first, as in techno.
   */
  private acid(b: Bus, r: SoundRound | undefined): void {
    const n = ACID_STEPS;
    const step = this.bar / n;
    const counts = steps(r?.hits ?? [], this.bar, n);
    const most = Math.max(1, ...counts);
    const total = r?.hits.length || 1;
    let arrived = 0;
    const root = ROOTS[r?.origin ?? 'eu'] + 12;
    const kicks: number[] = [];
    for (let s = 0; s < n; s += 4) if (r) kicks.push(s);
    const hot = this.drive(b, 2.5, 0.75);
    const line = this.duck(
      kicks.map((s) => b.t0 + s * step),
      this.drive(b, 4, 0.42, 0.12, 0.25),
      0.5,
    );
    const wave = 0.65 + 0.35 * Math.sin((this.barCount / 8) * 2 * Math.PI);
    let before: number | undefined;
    for (let s = 0; s < n; s++) {
      const t = b.t0 + s * step;
      const count = counts[s]!;
      arrived += count;
      const share = arrived / total;
      if (kicks.includes(s)) this.kick(b, t, 0.8, hot);
      if (r && s % 8 === 4) this.clap(b, t, 0.16);
      if (r && s % 4 === 2) this.hat(b, t, 0.05, { open: true });
      if (count) this.hat(b, t, 0.02 + 0.06 * (count / most), { pan: s % 2 ? 0.3 : -0.3 });
      const midi = root + (count ? ACID[(count * 3 + s) % ACID.length]! : s % 4 === 3 ? 12 : 0);
      const slide = count > 0 && s > 0 && counts[s - 1]! > 0;
      this.squelch(t, midi, {
        to: line,
        length: step * (slide ? 1.3 : 0.8),
        cutoff: (240 + 1900 * share) * wave,
        sweep: 700 + 2200 * share,
        q: 15,
        gain: 0.1,
        accent: count > 0 && count >= most * 0.6,
        from: slide ? before : undefined,
      });
      before = midi;
    }
  }
}
