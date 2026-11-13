import type { NodeState, Wave } from '../../shared/types.ts';
import type { WavePlan } from './stats.ts';

/**
 * The health wall as sound. Every finished round becomes a SoundRound (who got the block, when in the
 * wall's replay, where on the map); a sound turns that into notes. Everything is synthesised with Web
 * Audio, nothing is loaded. The page may only make sound after a click, so the player starts on demand.
 */

export const SOUNDS = ['droplets', 'kalimba', 'glass', 'techno'] as const;
/** Techno candidates. They are not on the wall's switch yet: the listen sheet plays them. */
export const LAB = ['groove', 'network', 'arrange', 'acid', 'dub', 'breaks'] as const;
export type LabName = (typeof LAB)[number];
export type SoundName = (typeof SOUNDS)[number] | LabName;
export const SOUND_LABELS: Record<SoundName, string> = {
  droplets: 'DROPLETS',
  kalimba: 'KALIMBA',
  glass: 'GLASS',
  techno: 'TECHNO',
  groove: 'GROOVE',
  network: 'NETWORK',
  arrange: 'ARRANGE',
  acid: 'ACID',
  dub: 'DUB',
  breaks: 'BREAKS',
};
/**
 * Droplets and kalimba sound the moment a round arrives, in step with the wall's flashes. The others are
 * rhythmic, so they keep their own steady bar (one bar per block time) and pick up the newest round at
 * each bar line: an uneven round arrival must not bend the beat.
 */
const ON_BAR = new Set<SoundName>(['glass', 'techno', ...LAB]);
/**
 * The lab sounds' bar: steps (four to a beat, so 24 is six beats a block, about 129 BPM at 2.8 s, and 32 is
 * eight, about 171) and the echo, its delay as a share of the bar and how much of it feeds back.
 */
const KIT: Record<LabName, { steps: number; echo: number; feedback: number }> = {
  groove: { steps: 24, echo: 3 / 24, feedback: 0.4 },
  network: { steps: 24, echo: 3 / 24, feedback: 0.45 },
  arrange: { steps: 24, echo: 3 / 24, feedback: 0.45 },
  acid: { steps: 24, echo: 3 / 24, feedback: 0.4 },
  dub: { steps: 24, echo: 3 / 24, feedback: 0.62 },
  breaks: { steps: 32, echo: 3 / 32, feedback: 0.35 },
};
const isLab = (name: SoundName): name is LabName => name in KIT;
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
  /** Real ms until 95% of the nodes had the block. `hits` run on the replay clock, which hides it. */
  spread: number;
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
    spread: plan.max,
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

/**
 * A bar cut into `n` steps, per step: arrivals, where they sit left to right on average, the part of the
 * world most of them are in, and the share of all nodes that has the block once the step is over.
 */
export function grid(r: SoundRound | undefined, bar: number, n: number) {
  const hits = r?.hits ?? [];
  const counts = steps(hits, bar, n);
  const pans = counts.map(() => 0);
  const tally = counts.map((): Partial<Record<Region, number>> => ({}));
  for (const h of hits) {
    const s = stepOf(h.at, bar, n);
    pans[s]! += h.pan;
    tally[s]![h.region] = (tally[s]![h.region] ?? 0) + 1;
  }
  let arrived = 0;
  return {
    counts,
    most: Math.max(1, ...counts),
    pans: pans.map((p, s) => (counts[s] ? p / counts[s]! : 0)),
    lead: tally.map((t) => (Object.entries(t) as [Region, number][]).sort((a, b) => b[1] - a[1])[0]?.[0]),
    share: counts.map((c) => {
      arrived += c;
      return arrived / Math.max(1, hits.length);
    }),
  };
}

/** When a share of a region's nodes (or of all, without a region) has the block, seconds; null if none. */
export function reach(hits: SoundHit[], share: number, region?: Region): number | null {
  const group = region ? hits.filter((h) => h.region === region) : hits;
  return group.length ? group[Math.min(group.length - 1, Math.floor(group.length * share))]!.at : null;
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
/** Network: the bass note a part of the world stands for, in semitones over the root, and its drum, Hz */
const REGION_NOTE: Record<Region, number> = { eu: 0, na: 3, as: 7, other: 10 };
const REGION_DRUM: Record<Region, number> = { eu: 196, na: 147, as: 247, other: 175 };
/** Sixteen steps of bass, semitones over the root. A block holds 24 steps, so the line comes home every two blocks. */
const BASS = [0, 0, 0, 12, 0, 0, 7, 0, 0, 0, 0, 12, 0, 10, 0, 3];
const ACID = [0, 12, 3, 0, 7, 10, 0, 15];
const MINOR7 = [0, 3, 7, 10];
/** Off-sixteenths come this share of a step late */
const SWING = 0.14;

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
  echo?: number;
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
  /** Lab sounds: the last round, bars since it came, the usual spread and whether the last round was slow */
  private last?: SoundRound;
  private idle = 0;
  private usual = 0;
  private slow = false;
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
    this.usual = 0;
    // let the previous sound's echo run out unheard, then open it for this one
    const now = this.ac!.currentTime;
    for (const [g, v] of [
      [this.feedback!, isLab(name) ? KIT[name].feedback : 0],
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
    else if (isLab(this.name)) {
      if (fresh) {
        this.slow = this.usual > 0 && fresh.spread > 1.6 * this.usual;
        this.usual = this.usual ? 0.85 * this.usual + 0.15 * fresh.spread : fresh.spread;
        this.last = fresh;
        this.idle = 0;
      } else {
        this.slow = false;
        this.idle++;
      }
      // a round that misses the bar line by a moment plays the last one again; two empty bars are a stall
      const round = fresh ?? (this.idle < 2 ? this.last : undefined);
      this.echo!.delayTime.setTargetAtTime(this.bar * KIT[this.name].echo, bus.t0, 0.02);
      if (this.name === 'acid') this.acid(bus, round);
      else if (this.name === 'dub') this.dub(bus, round);
      else if (this.name === 'breaks') this.breaks(bus, round);
      else this.groove(bus, round, this.name);
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
    head.connect(g).connect(o.to ?? this.sink(b, o.pan, o.wet, o.echo));
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
      echo?: number;
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
      .connect(o.to ?? this.sink(b, o.pan, o.wet ?? 0.1, o.echo));
    src.start(t, Math.random() * 0.5);
    src.stop(t + o.decay + 0.06);
  }

  // ─── the lab kit ──────────────────────────────────────────────────────────

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
  private clap(b: Bus, t: number, gain: number, echo = 0): void {
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
    this.hiss(b, t + 0.03, { band: 'bandpass', freq: 1300, q: 0.8, gain, decay: 0.16, wet: 0.3, echo });
  }

  private snare(b: Bus, t: number, gain: number): void {
    this.hiss(b, t, { band: 'bandpass', freq: 2200, q: 0.7, gain, decay: 0.13, wet: 0.2 });
    this.note(b, t, 185, {
      type: 'triangle',
      from: 1.6,
      glide: 0.03,
      gain: gain * 0.8,
      decay: 0.09,
      wet: 0.1,
    });
  }

  private hat(
    b: Bus,
    t: number,
    gain: number,
    o: { open?: boolean; pan?: number; echo?: number } = {},
  ): void {
    this.hiss(b, t, {
      freq: o.open ? 6500 : 8000,
      gain,
      decay: o.open ? 0.16 : 0.035,
      pan: o.pan,
      wet: o.open ? 0.15 : 0.1,
      echo: o.echo,
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

  /** Detuned saws through one low-pass that moves from `open` times the cutoff to the cutoff: stabs, pads, a reese bass */
  private chord(
    b: Bus,
    t: number,
    midis: number[],
    o: {
      gain: number;
      decay: number;
      cutoff: number;
      open?: number;
      attack?: number;
      detune?: number;
      q?: number;
      pan?: number;
      wet?: number;
      echo?: number;
      to?: AudioNode;
    },
  ): void {
    const ac = this.ac!;
    const attack = o.attack ?? 0.005;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = o.q ?? 2;
    lp.frequency.setValueAtTime(o.cutoff * (o.open ?? 3), t);
    lp.frequency.exponentialRampToValueAtTime(o.cutoff, t + attack + o.decay * 0.6);
    const g = ac.createGain();
    this.envelope(g, t, o.gain, attack, o.decay);
    lp.connect(g).connect(o.to ?? this.sink(b, o.pan, o.wet ?? 0.3, o.echo));
    for (const midi of midis) {
      for (const cents of [-(o.detune ?? 7), o.detune ?? 7]) {
        const osc = ac.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz(midi);
        osc.detune.value = cents;
        osc.connect(lp);
        osc.start(t);
        osc.stop(t + attack + o.decay + 0.05);
      }
    }
  }

  /** Noise that climbs and swells for `length` seconds, then cuts */
  private riser(b: Bus, t: number, length: number, gain: number): void {
    const ac = this.ac!;
    const src = ac.createBufferSource();
    src.buffer = this.noise!;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.5;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(9000, t + length);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain * 0.06, t);
    g.gain.exponentialRampToValueAtTime(gain, t + length);
    g.gain.linearRampToValueAtTime(0.0001, t + length + 0.04);
    src
      .connect(f)
      .connect(g)
      .connect(this.sink(b, 0, 0.4));
    src.start(t);
    src.stop(t + length + 0.1);
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

  // ─── the lab: techno candidates ───────────────────────────────────────────

  /**
   * Six beats a block with a driven kick, a layered clap, an open hat off the beat, swing and a ducked
   * 303-like bass; hats from the arrivals and the bass filter opening as the block spreads, as in techno.
   *
   * `network` puts more of the round into it: hats sit where their nodes are on the map, the bass plays the
   * note of the part of the world most of a step's arrivals are in, the last tenth of the nodes are drums,
   * a chord lands when 95% have the block, and a round that spread slowly loses its first three kicks.
   *
   * `arrange` plays a phrase of sixteen blocks: eight of groove with a fill every fourth, three of
   * breakdown, one of build, four of drop.
   */
  private groove(b: Bus, r: SoundRound | undefined, mode: 'groove' | 'network' | 'arrange'): void {
    const n = KIT[mode].steps;
    const step = this.bar / n;
    const at = (s: number) => b.t0 + (s + (s % 2 ? SWING : 0)) * step;
    const g = grid(r, this.bar, n);
    const root = ROOTS[r?.origin ?? 'eu'];
    const phrase = this.barCount % 16;
    const part =
      mode !== 'arrange' || phrase < 8 ? 'groove' : phrase < 11 ? 'break' : phrase === 11 ? 'build' : 'drop';
    // without a round for two bars the network has stalled: the drums stop and the bass goes dull
    const drums = !!r && (part === 'groove' || part === 'drop');
    const fill = mode === 'arrange' && part === 'groove' && phrase % 4 === 3;
    const tense = mode === 'network' && this.slow;
    const kicks: number[] = [];
    for (let s = 0; s < n; s += 4) if (drums && !(tense && s < 12) && !(fill && s >= 20)) kicks.push(s);
    const hot = this.drive(b, 2.5, 0.75);
    const pump = this.duck(kicks.map(at), this.drive(b, 1.6, 0.62, 0.05));
    let region: Region = r?.origin ?? 'eu';
    for (let s = 0; s < n; s++) {
      const t = at(s);
      if (kicks.includes(s)) this.kick(b, t, 0.8, hot);
      if (drums && s % 8 === 4) this.clap(b, t, 0.2, 0.12);
      if (drums && s % 4 === 2 && !(mode === 'arrange' && part === 'groove' && phrase < 4)) {
        this.hat(b, t, part === 'drop' ? 0.09 : 0.06, { open: true });
      }
      if (g.counts[s]) {
        this.hat(b, t, 0.03 + 0.1 * (g.counts[s]! / g.most), {
          pan: mode === 'network' ? g.pans[s]! * 1.8 : s % 2 ? 0.3 : -0.3,
          echo: part === 'break' ? 0.3 : 0,
        });
      }
      if (fill && s >= 20) this.snare(b, t, 0.1 + 0.04 * (s - 20));
      if (s % 4 === 0) continue;
      const k = (this.barCount * n + s) % 16;
      region = g.lead[s] ?? region;
      const interval = mode === 'network' ? REGION_NOTE[region] + (BASS[k] === 12 ? 12 : 0) : BASS[k]!;
      this.squelch(t, root + interval, {
        to: pump,
        length: step * 0.9,
        cutoff:
          part === 'build'
            ? 200 + 2600 * (s / n)
            : (180 + 2600 * g.share[s]!) * (part === 'break' ? 0.45 : 1),
        sweep: 500,
        accent: k % 8 === 3 || k === 13,
      });
    }
    const chord = MINOR7.map((i) => root + 24 + i);
    if (mode === 'network' && r) {
      const late = new Map(
        r.hits
          .slice(Math.max(1, Math.floor(r.hits.length * 0.9)))
          .map((h): [number, SoundHit] => [stepOf(h.at, this.bar, n), h]),
      );
      for (const [s, h] of late) {
        this.note(b, at(s), REGION_DRUM[h.region], {
          from: 1.7,
          glide: 0.03,
          gain: 0.16,
          decay: 0.1,
          pan: h.pan * 1.8,
          wet: 0.3,
          echo: 0.25,
        });
      }
      const most = reach(r.hits, 0.95);
      if (most !== null) {
        this.chord(b, at(stepOf(most, this.bar, n)), chord, {
          gain: 0.05,
          decay: 0.3,
          cutoff: 900,
          echo: 0.5,
        });
      }
      if (tense) {
        this.note(b, b.t0, hz(root + 13), {
          type: 'sawtooth',
          gain: 0.07,
          attack: 0.4,
          decay: this.bar * 0.5,
          lowpass: 420,
          q: 3,
          wet: 0.5,
        });
      }
    }
    if (mode !== 'arrange') return;
    if (r && (phrase === 0 || phrase === 12))
      this.hiss(b, b.t0, { freq: 4500, gain: 0.1, decay: 1.6, wet: 0.5 });
    if (part === 'break') {
      this.chord(b, b.t0, chord, {
        gain: 0.09,
        attack: 0.5,
        decay: this.bar,
        cutoff: 800,
        open: 0.4,
        wet: 0.6,
      });
    }
    if (part === 'build') {
      this.riser(b, b.t0, this.bar, 0.28);
      // a roll that doubles its speed twice on the way to the drop
      for (let s = 0; s < n; s += s < 12 ? 2 : s < 20 ? 1 : 0.5)
        this.snare(b, b.t0 + s * step, 0.07 + 0.2 * (s / n));
    }
    if (part === 'drop') {
      for (let s = 0; s < n; s++) {
        if (s % 8 === 3 || s % 8 === 6) {
          this.chord(b, at(s), chord, { gain: 0.045, decay: 0.18, cutoff: 1400, echo: 0.35 });
        }
      }
    }
  }

  /**
   * Plain drums under a 303 line that the round writes: a step with arrivals picks its note from how many
   * came, a busy step is accented, arrivals in neighbouring steps slide into each other. The filter opens
   * with the spread and rides a slow wave of eight blocks.
   */
  private acid(b: Bus, r: SoundRound | undefined): void {
    const n = KIT.acid.steps;
    const step = this.bar / n;
    const g = grid(r, this.bar, n);
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
      const count = g.counts[s]!;
      if (kicks.includes(s)) this.kick(b, t, 0.8, hot);
      if (r && s % 8 === 4) this.clap(b, t, 0.16);
      if (r && s % 4 === 2) this.hat(b, t, 0.05, { open: true });
      if (count) this.hat(b, t, 0.02 + 0.06 * (count / g.most), { pan: s % 2 ? 0.3 : -0.3 });
      const midi = root + (count ? ACID[(count * 3 + s) % ACID.length]! : s % 4 === 3 ? 12 : 0);
      const slide = count > 0 && s > 0 && g.counts[s - 1]! > 0;
      this.squelch(t, midi, {
        to: line,
        length: step * (slide ? 1.3 : 0.8),
        cutoff: (240 + 1900 * g.share[s]!) * wave,
        sweep: 700 + 2200 * g.share[s]!,
        q: 15,
        gain: 0.1,
        accent: count > 0 && count >= g.most * 0.6,
        from: slide ? before : undefined,
      });
      before = midi;
    }
  }

  /**
   * A soft kick, a sub off the beat and a minor ninth chord that lands when a quarter, half, three
   * quarters and 95% of the nodes have the block, brighter each time, into a long echo: the stabs draw the
   * round's arrival curve.
   */
  private dub(b: Bus, r: SoundRound | undefined): void {
    const n = KIT.dub.steps;
    const step = this.bar / n;
    const at = (s: number) => b.t0 + (s + (s % 2 ? SWING : 0)) * step;
    const g = grid(r, this.bar, n);
    const root = ROOTS[r?.origin ?? 'eu'];
    const kicks: number[] = [];
    for (let s = 0; s < n; s += 4) if (r) kicks.push(s);
    const pump = this.duck(kicks.map(at), this.sink(b, 0, 0), 0.3, 0.3);
    for (let s = 0; s < n; s++) {
      const t = at(s);
      if (kicks.includes(s)) this.kick(b, t, 0.6);
      if (r && s % 8 === 4) {
        this.hiss(b, t, { band: 'bandpass', freq: 2400, q: 3, gain: 0.09, decay: 0.03, wet: 0.4, echo: 0.3 });
      }
      if (g.counts[s]) {
        this.hat(b, t, 0.015 + 0.05 * (g.counts[s]! / g.most), { pan: g.pans[s]! * 1.8, echo: 0.1 });
      }
      if (s % 4 === 2 || s % 8 === 7) {
        this.note(b, t, hz(root), { gain: 0.32, attack: 0.01, decay: step * 1.6, to: pump });
      }
    }
    if (!r) return;
    const chord = [...MINOR7, 14].map((i) => root + 24 + i);
    let taken = -1;
    [0.25, 0.5, 0.75, 0.95].forEach((share, j) => {
      const when = reach(r.hits, share);
      if (when === null) return;
      taken = Math.min(n - 1, Math.max(taken + 1, stepOf(when, this.bar, n)));
      this.chord(b, at(taken), chord, {
        gain: 0.05,
        decay: 0.22,
        cutoff: 500 + 450 * j,
        open: 2.5,
        q: 3,
        pan: j % 2 ? 0.35 : -0.35,
        wet: 0.45,
        echo: 0.6,
      });
    });
  }

  /**
   * Eight beats a block, about 171 BPM: a two-step break (kick on 1 and the "and" of 3, snare on 2 and 4),
   * twice per block, over a reese bass whose filter opens with the spread. Hats come from the arrivals.
   */
  private breaks(b: Bus, r: SoundRound | undefined): void {
    const n = KIT.breaks.steps;
    const step = this.bar / n;
    const g = grid(r, this.bar, n);
    const root = ROOTS[r?.origin ?? 'eu'] + 12;
    const kicks: number[] = [];
    for (let s = 0; s < n; s++) if (r && (s % 16 === 0 || s % 16 === 10)) kicks.push(s);
    const hot = this.drive(b, 2.5, 0.75);
    const pump = this.duck(
      kicks.map((s) => b.t0 + s * step),
      this.drive(b, 2, 0.7, 0.05),
      0.3,
      0.15,
    );
    for (let s = 0; s < n; s++) {
      const t = b.t0 + s * step;
      if (kicks.includes(s)) this.kick(b, t, 0.8, hot);
      if (r && s % 8 === 4) this.snare(b, t, 0.24);
      // a ghost note in the second bar, and a short run into every fourth block
      if (r && (s === 23 || (this.barCount % 4 === 3 && s >= 29))) this.snare(b, t, 0.08);
      if (g.counts[s]) this.hat(b, t, 0.03 + 0.09 * (g.counts[s]! / g.most), { pan: s % 2 ? 0.3 : -0.3 });
      else if (r && s % 2 === 0) this.hat(b, t, 0.012);
      if (s % 16 === 0 || s === 28) {
        const length = step * (s === 28 ? 3.5 : s === 16 ? 11.5 : 15.5);
        this.chord(b, t, [root + (s === 28 ? 3 : 0)], {
          gain: 0.13,
          attack: 0.01,
          decay: length,
          cutoff: 200 + 1900 * g.share[Math.min(n - 1, s + 8)]!,
          open: 0.5,
          detune: 22,
          q: 4,
          to: pump,
        });
        this.note(b, t, hz(root - 12 + (s === 28 ? 3 : 0)), {
          gain: 0.2,
          attack: 0.02,
          decay: length,
          to: pump,
        });
      }
    }
  }
}
