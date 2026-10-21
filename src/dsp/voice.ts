import { SAMPLE_RATE, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { defaultFx } from "../core/defaults.ts";
import { evalModulated } from "../core/modulate.ts";
import { isDrum, LANES, type Fx, type LaneId } from "../core/types.ts";
import type { EngineParam } from "./map.ts";
import type { BlockEvent, LoopEvent, Motion } from "./schedule.ts";
import { clearEcho, clearTank, createEcho, createTank, echoSample, tankSample, type Echo, type Tank } from "./fx.ts";

const TWO_PI = Math.PI * 2;
const DRUM_COUNT = 4;
const NOTE_COUNT = 12;
const LANE_COUNT = 8;
const LANE_MOTION_CAP = 12;
const WT_FRAMES = 48;
const WT_CYCLE = 256;
const WT_MIPS = 7;
const WT_HARM = 64;
const WT_ANCHOR = [0, 0.22, 0.42, 0.62, 0.82, 1];

const P_NONE = 0;
const P_FREQ = 1;
const P_DECAY = 2;
const P_PBEND = 3;
const P_BTIME = 4;
const P_BODY = 5;
const P_CLICK = 6;
const P_NOISE = 7;
const P_DIST = 8;
const P_BDCY = 9;
const P_NDCY = 10;
const P_SNAP = 11;
const P_TONE = 12;
const P_METAL = 13;
const P_COLOR = 14;
const P_ATK = 15;
const P_RING = 16;
const P_POS = 17;
const P_MAT = 18;
const P_FM = 19;
const P_RATIO = 20;
const P_DAMP = 21;
const P_WAVE = 22;
const P_BEND = 23;
const P_SYNC = 24;
const P_FOLD = 25;
const P_CUTOFF = 26;
const P_RESONANCE = 27;
const P_ATTACK = 28;
const P_RELEASE = 29;
const P_WIDE = 30;
const P_REVERB = 31;
const P_DELAY = 32;
const P_NOTE_DRIVE = 33;

export interface Engine {
  noise: number;
  drums: DrumVoice[];
  notes: NoteVoice[];
  phrase: LoopEvent[];
  motions: Motion[];
  clock: number;
  tempo: number;
  beats: number;
  fx: Fx;
  tank: Tank;
  echo: Echo;
  /** Pitched-note timing of the phrase last loaded. Same grid must not re-attack. */
  holdSig: string;
  lanes: LaneBox[];
}

interface DrumVoice {
  on: boolean;
  lane: number;
  phase0: number;
  phase1: number;
  phase2: number;
  phase3: number;
  clickPhase: number;
  env: number;
  noiseEnv: number;
  pitchEnv: number;
  clickEnv: number;
  age: number;
  /** Base Hz, stamped at the hit. */
  freq: number;
  /** Body amplitude time, seconds. Hat metal is lengthened by `ring` on top of this. */
  decay: number;
  noiseDecay: number;
  /** Pitch-envelope time, seconds. Independent of `decay` on the kick. */
  bendTime: number;
  /** Downward pitch sweep in octaves. */
  bend: number;
  /** Spectrum macro: kick/snare body, hat metal, perc material. */
  body: number;
  noise: number;
  /** Spectral tilt. Kick derives it from body; snare tone and hat color write it. */
  tone: number;
  /** Transient amount: kick click, snare snap, hat/perc attack. */
  click: number;
  drive: number;
  /** Extra FM index. The spectrum macro can add its own. */
  fm: number;
  /** Musical modulator ratio. */
  ratio: number;
  ring: number;
  /** Hat pan. 0 left, 0.5 center, 1 right. */
  pos: number;
  damp: number;
  cutoff: number;
  resonance: number;
  reverb: number;
  delay: number;
  nlp: number;
  nhp: number;
  flt: number;
  band: number;
  loop: number;
  envK: number;
  noiseK: number;
  pitchK: number;
  clickK: number;
  /** Hit level. Body and noise envelopes already start here; the transient has its own shape and uses this as a gain. */
  gain: number;
}

interface NoteVoice {
  on: boolean;
  phase: number;
  phase2: number;
  slave: number;
  slave2: number;
  env: number;
  age: number;
  left: number;
  freq: number;
  wave: number;
  bend: number;
  sync: number;
  fold: number;
  drive: number;
  wide: number;
  cutoff: number;
  resonance: number;
  reverb: number;
  delay: number;
  attack: number;
  release: number;
  gain: number;
  low: number;
  band: number;
  lane: number;
  loop: number;
  releaseK: number;
}

interface LaneMotion {
  param: number;
  pattern: number;
  value: number;
  cycle: number;
  amount: number;
}

interface LaneBox {
  live: LaneMotion[];
  still: LaneMotion[];
}

export function createEngine(): Engine {
  return {
    noise: 1,
    drums: Array.from({ length: DRUM_COUNT }, emptyDrum),
    notes: Array.from({ length: NOTE_COUNT }, emptyNote),
    phrase: [],
    motions: [],
    clock: 0,
    tempo: 120,
    beats: 4,
    fx: defaultFx(),
    tank: createTank(),
    echo: createEcho(),
    holdSig: "",
    lanes: emptyLanes(),
  };
}

/** Store a looping phrase. `reset` starts the audio clock at the downbeat. */
export function loadPhrase(engine: Engine, events: LoopEvent[], tempo: number, reset: boolean, motions: Motion[] = []): void {
  const sig = holdSig(events);
  const previous = engine.holdSig;
  engine.phrase = events;
  engine.motions = motions;
  engine.tempo = Math.max(1, tempo);
  engine.holdSig = sig;
  bucketMotions(engine, motions);
  stampHeld(engine);
  if (reset) {
    engine.clock = 0;
    clearTank(engine.tank);
    clearEcho(engine.echo);
    return;
  }
  if (engine.clock > 0 && sig !== previous) catchHolding(engine);
}

/** Notes already under the playhead when a knob rebuilds the grid. Drums stay put. Length is not part of the grid: a sounding note keeps the length it started with, and the next note-on reads the new one. */
function holdSig(events: LoopEvent[]): string {
  let sig = "";
  for (const event of events) {
    if (isDrum(event.lane)) continue;
    sig += `${event.lane}:${event.sample}:${event.loop}:${event.note};`;
  }
  return sig;
}

function catchHolding(engine: Engine): void {
  const tempo = Math.max(1, engine.tempo);
  for (const event of engine.phrase) {
    if (isDrum(event.lane)) continue;
    const loop = Math.max(1, event.loop);
    const pos = ((engine.clock % loop) + loop) % loop;
    const start = ((event.sample % loop) + loop) % loop;
    const dur = Math.max(1, Math.round((event.lengthTicks * SAMPLE_RATE * 60) / (tempo * 192)));
    let elapsed = pos - start;
    if (elapsed < 0) elapsed += loop;
    if (elapsed <= 0 || elapsed >= dur) continue;
    armNote(engine, steal(engine), event, dur - elapsed, loop);
  }
}

/** One shared-memory write: a phrase the voice loops on its own sample clock. */
export function packPhrase(events: LoopEvent[], tempo: number, reset: boolean, motions: Motion[] = []): string {
  return `P|${tempo}|${reset ? 1 : 0}|${packPhraseBody(events, motions)}`;
}

export function packPhraseBody(events: LoopEvent[], motions: Motion[] = [], fx = ""): string {
  const body = events.map((event) => {
    const lane = LANES.indexOf(event.lane);
    const params = event.params.map((param) => `${param.id}=${param.value.toFixed(4)}`).join(",");
    return `${event.sample}:${event.loop}:${lane}:${event.note}:${event.velocity}:${event.lengthTicks}:${params}`;
  }).join(";");
  if (!motions.length) return fx ? `${body}@${fx}` : body;
  const tail = motions.map((motion) => {
    const lane = LANES.indexOf(motion.lane);
    const head = `${lane}:${motion.id}:${motion.value.toFixed(4)}:${Math.round(motion.pattern)}:${Math.round(motion.cycle)}:${motion.amount.toFixed(4)}:${motion.loop}`;
    return head;
  }).join(";");
  const packed = `${body}#${tail}`;
  return fx ? `${packed}@${fx}` : packed;
}

/** Bass, Lead and Chords share these twelve notes. Drums keep one voice each. */
export function renderBlock(engine: Engine, events: BlockEvent[], tempo: number, frames = 128): Float32Array {
  return renderFrames(engine, frames, (frame) => {
    for (const event of events) {
      if (event.sampleOffset === frame) trigger(engine, event, Math.max(1, tempo));
    }
  });
}

const FOLLOW_STRIDE = 8;

/** Advance the voice clock by real audio frames and retrigger the stored phrase. */
export function renderClock(engine: Engine, frames = 128): Float32Array {
  const tempo = engine.tempo;
  const fires: { offset: number; event: (typeof engine.phrase)[number] }[] = [];
  const C = engine.clock;
  for (const event of engine.phrase) {
    const loop = Math.max(1, event.loop);
    const mod = ((C % loop) + loop) % loop;
    let t0 = event.sample - mod;
    if (t0 < 0) t0 += loop;
    for (let t = t0; t < frames; t += loop) fires.push({ offset: t, event });
  }
  fires.sort((a, b) => a.offset - b.offset);
  let fi = 0;
  return renderFrames(engine, frames, (frame) => {
    while (fi < fires.length && fires[fi].offset === frame) {
      trigger(engine, fires[fi].event, tempo);
      fi += 1;
    }
    engine.clock += 1;
  });
}

function renderFrames(engine: Engine, frames: number, at: (frame: number) => void): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    at(i);
    if ((i & (FOLLOW_STRIDE - 1)) === 0) follow(engine);
    let left = 0;
    let right = 0;
    let revL = 0;
    let revR = 0;
    let dlyL = 0;
    let dlyR = 0;
    for (const drum of engine.drums) {
      if (!drum.on) continue;
      const pair = drumSample(engine, drum);
      left += pair[0];
      right += pair[1];
      revL += pair[0] * drum.reverb;
      revR += pair[1] * drum.reverb;
      dlyL += pair[0] * drum.delay;
      dlyR += pair[1] * drum.delay;
    }
    for (const note of engine.notes) {
      if (!note.on) continue;
      const pair = noteSample(engine, note);
      left += pair[0];
      right += pair[1];
      revL += pair[0] * note.reverb;
      revR += pair[1] * note.reverb;
      dlyL += pair[0] * note.delay;
      dlyR += pair[1] * note.delay;
    }
    const wetR = tankSample(engine.tank, engine.fx.reverb, revL, revR);
    const wetD = echoSample(engine.echo, engine.fx.delay, engine.beats, engine.tempo, dlyL, dlyR);
    out[i * 2] = soft(left + wetR[0] + wetD[0]);
    out[i * 2 + 1] = soft(right + wetR[1] + wetD[1]);
  }
  return out;
}

/** One shared-memory write: tempo, then the events of this audio block. */
export function packBlock(events: BlockEvent[], tempo: number): string {
  const body = events.map((event) => {
    const lane = LANES.indexOf(event.lane);
    const params = event.params.map((param) => `${param.id}=${param.value.toFixed(4)}`).join(",");
    return `${event.sampleOffset}:${lane}:${event.note}:${event.velocity}:${event.lengthTicks}:${params}`;
  }).join(";");
  return `${tempo}|${body}`;
}

function trigger(engine: Engine, event: BlockEvent | LoopEvent, tempo: number): void {
  const loop = "loop" in event ? event.loop : 0;
  if (event.lane === "kick" || event.lane === "snare" || event.lane === "hat" || event.lane === "perc") {
    const drum = engine.drums[drumIndex(event.lane)];
    const pitch = read(event.params, ["freq"], 0.5);
    armDrum(drum, event, pitch, loop);
    return;
  }
  const note = steal(engine);
  const samples = Math.max(1, Math.round((event.lengthTicks * SAMPLE_RATE * 60) / (tempo * 192)));
  armNote(engine, note, event, samples, loop);
}

function armDrum(drum: DrumVoice, event: BlockEvent | LoopEvent, pitch: number, loop: number): void {
  const lane = drumIndex(event.lane);
  const vel = event.velocity / 127;
  drum.gain = vel;
  drum.on = true;
  drum.lane = lane;
  drum.phase0 = 0;
  drum.phase1 = 0;
  drum.phase2 = 0;
  drum.phase3 = 0;
  drum.clickPhase = 0;
  drum.env = vel;
  drum.noiseEnv = vel;
  drum.pitchEnv = 1;
  drum.age = 0;
  drum.freq = drumPitchHz(lane, pitch);
  drum.loop = loop;
  drum.nlp = 0;
  drum.nhp = 0;
  drum.flt = 0;
  drum.band = 0;
  drum.fm = 0;
  drum.ratio = 1;
  drum.ring = 0;
  drum.pos = 0.5;
  drum.damp = 0;
  drum.drive = 0;
  if (lane === 0) {
    drum.decay = kickDecaySeconds(knob(event, "decay", 0.4));
    drum.noiseDecay = 0.045;
    drum.bend = knob(event, "pbend", 0.4) * 3;
    drum.bendTime = bendTimeSeconds(knob(event, "btime", 0.4));
    drum.body = knob(event, "body", 0.1);
    drum.click = knob(event, "click", 0.1);
    drum.noise = knob(event, "noise", 0.1);
    drum.tone = 0.12 + drum.body * 0.35;
    drum.drive = knob(event, "dist", 0.05);
    drum.damp = 0.2;
  } else if (lane === 1) {
    drum.body = knob(event, "body", 0.3);
    drum.decay = snareBodyDecaySeconds(knob(event, "bdcy", 0.3));
    drum.noise = knob(event, "noise", 0.5);
    drum.noiseDecay = snareNoiseDecaySeconds(knob(event, "ndcy", 0.3));
    drum.click = knob(event, "snap", 0.4);
    drum.tone = knob(event, "tone", 0.5);
    drum.drive = knob(event, "dist", 0.1);
    const bend = snarePitchBend(drum.body);
    drum.bend = bend.bend;
    drum.bendTime = bend.bendTime;
    drum.ratio = 1.4 + drum.body * 0.8;
    drum.damp = 0;
  } else if (lane === 2) {
    drum.body = knob(event, "metal", 0.5);
    drum.noise = knob(event, "noise", 0.5);
    drum.tone = knob(event, "color", 0.5);
    drum.decay = hatDecaySeconds(knob(event, "decay", 0.3));
    drum.noiseDecay = drum.decay;
    drum.click = knob(event, "atk", 0.3);
    drum.ring = knob(event, "ring", 0.3);
    drum.pos = knob(event, "pos", 0.5);
    drum.bend = 0;
    drum.bendTime = 0.05;
  } else {
    drum.body = knob(event, "mat", 0.2);
    drum.decay = percDecaySeconds(knob(event, "decay", 0.4));
    drum.noiseDecay = Math.min(0.09, drum.decay * 0.4);
    drum.bend = knob(event, "pbend", 0.1) * 3.5;
    drum.bendTime = Math.max(0.03, drum.decay * 0.7);
    drum.fm = knob(event, "fm", 0);
    drum.ratio = fmRatioOf(knob(event, "ratio", 0.06));
    drum.click = knob(event, "atk", 0.3);
    drum.damp = knob(event, "damp", 0.4);
    drum.noise = percNoiseAmt(drum.body);
    drum.tone = percTone(drum.body);
  }
  drum.clickEnv = drum.click > 0.001 ? 1 : 0;
  drum.cutoff = read(event.params, ["cutoff"], 0.5);
  drum.resonance = read(event.params, ["resonance"], 0);
  drum.reverb = read(event.params, ["reverb"], 0);
  drum.delay = read(event.params, ["delay"], 0);
  refreshDrumEnv(drum);
}

function armNote(engine: Engine, note: NoteVoice, event: BlockEvent | LoopEvent, samples: number, loop: number): void {
  note.on = true;
  note.phase = 0;
  note.phase2 = 0;
  note.slave = 0;
  note.slave2 = 0;
  note.env = 0;
  note.age = 0;
  note.left = samples;
  note.lane = LANES.indexOf(event.lane);
  note.loop = loop;
  note.freq = 440 * 2 ** ((event.note - 69) / 12);
  note.wave = read(event.params, ["wave"], 0.36);
  note.bend = read(event.params, ["bend"], 0);
  note.sync = read(event.params, ["sync"], 0);
  note.fold = read(event.params, ["fold"], 0);
  note.drive = read(event.params, ["drive"], 0);
  note.cutoff = read(event.params, ["cutoff"], 0.5);
  note.resonance = read(event.params, ["resonance"], 0);
  note.reverb = read(event.params, ["reverb"], 0);
  note.delay = read(event.params, ["delay"], 0);
  note.attack = read(event.params, ["attack"], 0);
  note.release = read(event.params, ["release", "decay"], 0.4);
  note.wide = read(event.params, ["wide"], 0);
  note.gain = event.velocity / 127;
  note.low = 0;
  note.band = 0;
  refreshRelease(note);
  stampNote(engine, note);
}

function drumSample(engine: Engine, drum: DrumVoice): [number, number] {
  const freq = drum.freq * 2 ** (drum.bend * drum.pitchEnv);
  const body = drum.lane === 2 ? hatBody(drum, freq) : tonalBody(drum, freq);
  const noisy = noiseSample(engine, drum) * drum.noiseEnv;
  const click = transientSample(engine, drum) * drum.gain;
  let mid = body.mid * drum.env + noisy + click;
  let side = body.side * drum.env;
  if (drum.drive > 1e-4) {
    const amount = drum.drive * drum.drive;
    mid = shapeDrive(mid, amount);
    side = shapeDrive(side, amount);
  }
  const slot = { low: drum.flt, band: drum.band };
  const filtered = filterSample(slot, mid, drum.cutoff, drum.resonance);
  drum.flt = slot.low;
  drum.band = slot.band;
  drum.env *= drum.envK;
  drum.noiseEnv *= drum.noiseK;
  drum.pitchEnv *= drum.pitchK;
  drum.age += 1;
  if (drum.env < 0.0008 && drum.noiseEnv < 0.0008 && drum.clickEnv < 0.0008 && drum.age > 64) drum.on = false;
  if (drum.lane === 2) {
    const [left, right] = hatPan(drum.pos);
    return [filtered * left, filtered * right];
  }
  return [filtered + side, filtered - side];
}

/** 0 hard left, 0.5 center, 1 hard right. Center keeps both channels at full level. */
function hatPan(pos: number): [number, number] {
  const x = Math.max(0, Math.min(1, pos));
  const left = x <= 0.5 ? 1 : (1 - x) * 2;
  const right = x >= 0.5 ? 1 : x * 2;
  return [left, right];
}

function noteSample(_engine: Engine, note: NoteVoice): [number, number] {
  const inc = (TWO_PI * note.freq) / SAMPLE_RATE;
  const primary = advanceOsc(note, "phase", "slave", inc, note.sync, note.bend, note.wave);
  let mix = primary;
  let side = 0;
  if (note.wide > 1e-4) {
    const ratio = 2 ** ((note.wide * 15) / 1200);
    const second = advanceOsc(note, "phase2", "slave2", inc * ratio, note.sync, note.bend, note.wave);
    const w = note.wide;
    mix = primary * (1 - w * 0.5) + second * (w * 0.5);
    side = (primary - second) * w * 0.5;
  }
  if (note.fold > 1e-4) {
    const folded = Math.sin(mix * (1 + note.fold * note.fold * 4));
    mix += (folded - mix) * note.fold;
  }
  if (note.drive > 1e-4) {
    const amount = note.drive * note.drive * 5;
    const driven = mix * (1 + amount);
    mix = driven / (1 + amount * Math.abs(mix));
  }
  const resonated = filterSample(note, mix, note.cutoff, note.resonance);
  const attackSamples = 1 + note.attack * 0.2 * SAMPLE_RATE;
  // Hold full level for the whole note. Release is the tail after that length, not a decay from the attack.
  if (note.left > 0 && note.age < attackSamples) note.env = (note.age + 1) / attackSamples;
  else if (note.left > 0) note.env = 1;
  else note.env *= note.releaseK;
  note.age += 1;
  if (note.left > 0) note.left -= 1;
  if (note.left <= 0 && note.age >= attackSamples && note.env < 0.0008) note.on = false;
  const gain = resonated * note.env * note.gain * 0.38;
  const sided = side * note.env * note.gain * 0.38;
  return [gain + sided, gain - sided];
}

function gauss(k: number, center: number, sigma: number): number {
  const d = (k - center) / sigma;
  return Math.exp(-d * d);
}

/** Integer partial at one spectral anchor. Kind 0..5 is sine, triangle, saw, square, pulse, vowel. */
function anchorAmp(kind: number, k: number): number {
  if (kind === 0) return k === 1 ? 1 : 0;
  if (kind === 1) {
    if (k % 2 === 0) return 0;
    return (k % 4 === 1 ? 1 : -1) / (k * k);
  }
  if (kind === 2) return 1 / k;
  if (kind === 3) return k % 2 === 1 ? 1 / k : 0;
  if (kind === 4) return Math.sin(Math.PI * k * 0.12) / k;
  return 0.22 / k ** 1.5 + gauss(k, 3, 0.9) + 0.75 * gauss(k, 8, 1.2) + 0.55 * gauss(k, 14, 1.5);
}

function ampAt(p: number, k: number): number {
  if (p <= 0) return anchorAmp(0, k);
  if (p >= 1) return anchorAmp(5, k);
  let i = 0;
  while (i < 4 && p > WT_ANCHOR[i + 1]) i += 1;
  const span = WT_ANCHOR[i + 1] - WT_ANCHOR[i];
  const t = span > 0 ? (p - WT_ANCHOR[i]) / span : 0;
  return anchorAmp(i, k) * (1 - t) + anchorAmp(i + 1, k) * t;
}

function buildWaveTable(): Float32Array {
  const table = new Float32Array(WT_MIPS * WT_FRAMES * WT_CYCLE);
  const amp = new Float64Array(WT_HARM + 1);
  for (let mip = 0; mip < WT_MIPS; mip++) {
    const maxH = WT_HARM >> mip;
    for (let frame = 0; frame < WT_FRAMES; frame++) {
      const p = frame / (WT_FRAMES - 1);
      for (let k = 1; k <= maxH; k++) amp[k] = ampAt(p, k);
      let peak = 0;
      const base = (mip * WT_FRAMES + frame) * WT_CYCLE;
      for (let n = 0; n < WT_CYCLE; n++) {
        const theta = (TWO_PI * n) / WT_CYCLE;
        let sum = 0;
        for (let k = 1; k <= maxH; k++) sum += amp[k] * Math.sin(k * theta);
        table[base + n] = sum;
        const abs = Math.abs(sum);
        if (abs > peak) peak = abs;
      }
      if (peak > 1e-8) {
        const norm = 1 / peak;
        for (let n = 0; n < WT_CYCLE; n++) table[base + n] *= norm;
      }
    }
  }
  return table;
}

const WAVE_TABLE = buildWaveTable();

function readCycle(mip: number, frame: number, u: number): number {
  const pos = u * WT_CYCLE;
  const i0 = Math.floor(pos) % WT_CYCLE;
  const frac = pos - Math.floor(pos);
  const i1 = (i0 + 1) % WT_CYCLE;
  const base = (mip * WT_FRAMES + frame) * WT_CYCLE;
  const a = WAVE_TABLE[base + i0];
  const b = WAVE_TABLE[base + i1];
  return a + (b - a) * frac;
}

function readWave(freq: number, wave: number, u: number): number {
  const fit = Math.min(WT_HARM, Math.max(1, (SAMPLE_RATE * 0.45) / Math.max(freq, 1)));
  const mipF = Math.log2(WT_HARM / fit);
  let m0 = Math.floor(mipF);
  if (m0 < 0) m0 = 0;
  if (m0 > WT_MIPS - 1) m0 = WT_MIPS - 1;
  const top = m0 >= WT_MIPS - 1;
  const m1 = top ? m0 : m0 + 1;
  const mf = top ? 0 : mipF - m0;
  const pos = Math.max(0, Math.min(1, wave)) * (WT_FRAMES - 1);
  let f0 = Math.floor(pos);
  if (f0 >= WT_FRAMES - 1) f0 = WT_FRAMES - 2;
  const ff = pos - f0;
  const s0 = readCycle(m0, f0, u) * (1 - ff) + readCycle(m0, f0 + 1, u) * ff;
  if (mf < 1e-4) return s0;
  const s1 = readCycle(m1, f0, u) * (1 - ff) + readCycle(m1, f0 + 1, u) * ff;
  return s0 + (s1 - s0) * mf;
}

function bendUnit(u: number, bend: number): number {
  if (bend <= 1e-4 || u <= 0) return u;
  return u ** (1 + bend * bend * 3);
}

function advanceOsc(
  note: NoteVoice,
  phaseKey: "phase" | "phase2",
  slaveKey: "slave" | "slave2",
  inc: number,
  sync: number,
  bend: number,
  wave: number,
): number {
  let phase = note[phaseKey] + inc;
  let wrapped = false;
  if (phase >= TWO_PI) {
    phase -= TWO_PI;
    if (phase >= TWO_PI) phase %= TWO_PI;
    wrapped = true;
  }
  note[phaseKey] = phase;
  let u: number;
  let readFreq: number;
  if (sync > 1e-4) {
    const ratio = 1 + sync * sync * 4;
    let slave = note[slaveKey];
    if (wrapped) slave = 0;
    else {
      slave += inc * ratio;
      if (slave >= TWO_PI) slave %= TWO_PI;
    }
    note[slaveKey] = slave;
    u = slave / TWO_PI;
    readFreq = (inc * ratio * SAMPLE_RATE) / TWO_PI;
  } else {
    u = phase / TWO_PI;
    readFreq = (inc * SAMPLE_RATE) / TWO_PI;
  }
  return readWave(readFreq, wave, bendUnit(u, bend));
}

function shapeDrive(sample: number, drive: number): number {
  const gain = 1 + drive * 8;
  const driven = sample * gain;
  return driven / (1 + Math.abs(driven));
}

function follow(engine: Engine): void {
  const pos = engine.clock - 1;
  if (pos < 0) return;
  const span = Math.max(1, tickToSample(SIXTEENTH_TICKS, engine.tempo));
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const box = engine.lanes[lane];
    if (!box.live.length) continue;
    const loop = laneLoop(engine, lane);
    if (loop < 1) continue;
    const step = (pos % loop) / span;
    const units = box.live.map((motion) => evalMotion(motion, step));
    if (lane < DRUM_COUNT) {
      const drum = engine.drums[lane];
      for (let m = 0; m < box.live.length; m++) applyDrum(drum, box.live[m].param, units[m]);
    } else {
      for (const note of engine.notes) {
        if (!note.on || note.lane !== lane || note.loop < 1) continue;
        for (let m = 0; m < box.live.length; m++) applyNote(note, box.live[m].param, units[m]);
      }
    }
  }
}

function laneLoop(engine: Engine, lane: number): number {
  if (lane < DRUM_COUNT) {
    const drum = engine.drums[lane];
    return drum.on && drum.loop > 0 ? drum.loop : 0;
  }
  for (const note of engine.notes) {
    if (note.on && note.lane === lane && note.loop > 0) return note.loop;
  }
  return 0;
}

function applyDrum(drum: DrumVoice, param: number, unit: number): void {
  const u = Math.max(0, Math.min(1, unit));
  if (param === P_DECAY) {
    if (drum.lane === 2) {
      drum.decay = hatDecaySeconds(u);
      drum.noiseDecay = drum.decay;
    } else if (drum.lane === 3) {
      drum.decay = percDecaySeconds(u);
      drum.noiseDecay = Math.min(0.09, drum.decay * 0.4);
      drum.bendTime = Math.max(0.03, drum.decay * 0.7);
    } else drum.decay = kickDecaySeconds(u);
    refreshDrumEnv(drum);
  } else if (param === P_BDCY) {
    drum.decay = snareBodyDecaySeconds(u);
    refreshDrumEnv(drum);
  } else if (param === P_NDCY) {
    drum.noiseDecay = snareNoiseDecaySeconds(u);
    refreshDrumEnv(drum);
  } else if (param === P_PBEND) drum.bend = u * (drum.lane === 3 ? 3.5 : 3);
  else if (param === P_BTIME) {
    drum.bendTime = bendTimeSeconds(u);
    refreshDrumEnv(drum);
  } else if (param === P_BODY || param === P_MAT || param === P_METAL) {
    drum.body = u;
    if (drum.lane === 0) drum.tone = 0.12 + u * 0.35;
    if (drum.lane === 1) {
      drum.ratio = 1.4 + u * 0.8;
      const bend = snarePitchBend(u);
      drum.bend = bend.bend;
      drum.bendTime = bend.bendTime;
      refreshDrumEnv(drum);
    }
    if (drum.lane === 3) {
      drum.noise = percNoiseAmt(u);
      drum.tone = percTone(u);
    }
  } else if (param === P_CLICK || param === P_SNAP || param === P_ATK) {
    drum.click = u;
    refreshDrumEnv(drum);
  } else if (param === P_NOISE) drum.noise = u;
  else if (param === P_DIST) drum.drive = u;
  else if (param === P_TONE || param === P_COLOR) drum.tone = u;
  else if (param === P_RING) {
    drum.ring = u;
    refreshDrumEnv(drum);
  } else if (param === P_POS) drum.pos = u;
  else if (param === P_FM) drum.fm = u;
  else if (param === P_RATIO) drum.ratio = fmRatioOf(u);
  else if (param === P_DAMP) drum.damp = u;
  else if (param === P_CUTOFF) drum.cutoff = u;
  else if (param === P_RESONANCE) drum.resonance = u;
  else if (param === P_REVERB) drum.reverb = u;
  else if (param === P_DELAY) drum.delay = u;
}

function applyNote(note: NoteVoice, param: number, unit: number): void {
  if (param === P_WAVE) note.wave = unit;
  else if (param === P_BEND) note.bend = unit;
  else if (param === P_SYNC) note.sync = unit;
  else if (param === P_FOLD) note.fold = unit;
  else if (param === P_NOTE_DRIVE) note.drive = unit;
  else if (param === P_CUTOFF) note.cutoff = unit;
  else if (param === P_RESONANCE) note.resonance = unit;
  else if (param === P_REVERB) note.reverb = unit;
  else if (param === P_DELAY) note.delay = unit;
  else if (param === P_ATTACK) note.attack = unit;
  else if (param === P_RELEASE) {
    note.release = unit;
    refreshRelease(note);
  } else if (param === P_WIDE) note.wide = unit;
}

function refreshDrumEnv(drum: DrumVoice): void {
  const bodySec = drum.lane === 2 ? drum.decay * (1 + drum.ring * 2.8) : drum.decay;
  drum.envK = Math.exp(-1 / (Math.max(0.004, bodySec) * SAMPLE_RATE));
  drum.noiseK = Math.exp(-1 / (Math.max(0.003, drum.noiseDecay) * SAMPLE_RATE));
  drum.pitchK = Math.exp(-1 / (Math.max(0.004, drum.bendTime) * SAMPLE_RATE));
  const clickSamples = drum.lane === 1 ? 40 + (1 - drum.click) ** 1.4 * 700 : 12 + drum.click * 520;
  drum.clickK = Math.exp(-1 / Math.max(1, clickSamples));
}

function refreshRelease(note: NoteVoice): void {
  note.releaseK = Math.exp(-1 / ((0.04 + note.release * 1.6) * SAMPLE_RATE));
}

const Q_MIN = 0.707;
const Q_MAX = 14;

/** Peaks above the passband squash into a thick acid tone instead of a spike. */
function clipPeak(x: number): number {
  const a = Math.abs(x);
  if (a <= 1.25) return x;
  const y = 1.25 + (a - 1.25) / (1 + (a - 1.25));
  return x < 0 ? -y : y;
}

/**
 * One knob, two filters. 0.5 is dry. Below that a resonant high-pass opens
 * toward 0, above it a resonant low-pass closes toward 1. Distance from the
 * center is squared. Resonance is the peak on that corner: the top of the
 * knob is an acid sweep, and that peak is not level-matched away.
 * `low` and `band` are the two integrators. Drums keep them in `flt`/`band`,
 * apart from the tone low-pass.
 */
export function filterSample(state: { low: number; band: number }, input: number, cutoff: number, resonance: number): number {
  const offset = cutoff - 0.5;
  const amount = Math.min(1, Math.abs(offset) * 2);
  if (amount < 1e-4) {
    state.low = 0;
    state.band = 0;
    return input;
  }
  const shaped = amount * amount;
  const lp = offset > 0;
  const hz = lp ? 12000 * (90 / 12000) ** shaped : 40 * (7000 / 40) ** shaped;
  const q = Q_MIN * (Q_MAX / Q_MIN) ** Math.max(0, Math.min(1, resonance));
  const g = Math.tan((Math.PI * Math.min(hz, SAMPLE_RATE * 0.45)) / SAMPLE_RATE);
  const k = 1 / q;
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = input - state.low;
  const v1 = a1 * state.band + a2 * v3;
  const v2 = state.low + a2 * state.band + a3 * v3;
  state.band = 2 * v1 - state.band;
  state.low = 2 * v2 - state.low;
  const raw = lp ? v2 : input - k * v1 - v2;
  const trim = lp ? 1 + shaped * 0.5 : 1 + shaped * 2.5;
  return clipPeak(raw * trim);
}

function evalMotion(motion: LaneMotion, step: number): number {
  return evalModulated({
    value: motion.value,
    pattern: motion.pattern,
    cycle: motion.cycle,
    amount: motion.amount,
  }, step);
}

function bucketMotions(engine: Engine, motions: Motion[]): void {
  engine.lanes = emptyLanes();
  for (const motion of motions) {
    const lane = LANES.indexOf(motion.lane);
    const param = paramOf(motion.id);
    if (lane < 0 || lane >= LANE_COUNT || param === P_NONE || param === P_FREQ) continue;
    const box = engine.lanes[lane];
    const live = motion.amount !== 0;
    const list = live ? box.live : box.still;
    if (list.length >= LANE_MOTION_CAP) continue;
    list.push({
      param,
      pattern: motion.pattern,
      value: motion.value,
      cycle: motion.cycle,
      amount: motion.amount,
    });
  }
}

function stampHeld(engine: Engine): void {
  for (const note of engine.notes) {
    if (note.on) stampNote(engine, note);
  }
}

function stampNote(engine: Engine, note: NoteVoice): void {
  if (note.lane < DRUM_COUNT || note.lane >= LANE_COUNT) return;
  for (const motion of engine.lanes[note.lane].still) {
    applyNote(note, motion.param, Math.max(0, Math.min(1, motion.value)));
  }
}

function paramOf(id: string): number {
  if (id === "wave") return P_WAVE;
  if (id === "bend") return P_BEND;
  if (id === "sync") return P_SYNC;
  if (id === "fold") return P_FOLD;
  if (id === "drive") return P_NOTE_DRIVE;
  if (id === "cutoff") return P_CUTOFF;
  if (id === "resonance") return P_RESONANCE;
  if (id === "reverb") return P_REVERB;
  if (id === "delay") return P_DELAY;
  if (id === "attack") return P_ATTACK;
  if (id === "release" || id === "decay") return P_RELEASE;
  if (id === "wide") return P_WIDE;
  if (ends(id, "freq")) return P_FREQ;
  if (ends(id, "btime")) return P_BTIME;
  if (ends(id, "pbend")) return P_PBEND;
  if (ends(id, "bdcy")) return P_BDCY;
  if (ends(id, "ndcy")) return P_NDCY;
  if (ends(id, "decay")) return P_DECAY;
  if (ends(id, "click")) return P_CLICK;
  if (ends(id, "noise")) return P_NOISE;
  if (ends(id, "dist")) return P_DIST;
  if (ends(id, "body")) return P_BODY;
  if (ends(id, "snap")) return P_SNAP;
  if (ends(id, "tone")) return P_TONE;
  if (ends(id, "metal")) return P_METAL;
  if (ends(id, "color")) return P_COLOR;
  if (ends(id, "atk")) return P_ATK;
  if (ends(id, "ring")) return P_RING;
  if (ends(id, "pos")) return P_POS;
  if (ends(id, "ratio")) return P_RATIO;
  if (ends(id, "damp")) return P_DAMP;
  if (ends(id, "mat")) return P_MAT;
  if (ends(id, "fm")) return P_FM;
  return P_NONE;
}

function ends(id: string, suffix: string): boolean {
  return id === suffix || id.endsWith(`_${suffix}`);
}

function emptyLanes(): LaneBox[] {
  return Array.from({ length: LANE_COUNT }, () => ({ live: [], still: [] }));
}

function soft(sample: number): number {
  const scaled = sample * 0.35;
  return scaled / (1 + Math.abs(scaled));
}

/**
 * A block arms every tone before any of them renders, so each new one still
 * has age 0 and a silent envelope. Stealing the quietest voice would take the
 * tone just armed and leave a single voice once releases fill the pool.
 */
function steal(engine: Engine): NoteVoice {
  let quietRelease: NoteVoice | null = null;
  let oldestHeld: NoteVoice | null = null;
  for (const note of engine.notes) {
    if (!note.on) return note;
    if (note.age === 0) continue;
    if (note.left <= 0) {
      if (!quietRelease || note.env < quietRelease.env) quietRelease = note;
    } else if (!oldestHeld || note.age > oldestHeld.age) {
      oldestHeld = note;
    }
  }
  return quietRelease ?? oldestHeld ?? engine.notes[0];
}

function read(params: EngineParam[], keys: string[], fallback: number): number {
  for (const key of keys) {
    const found = params.find((param) => param.id === key || param.id.endsWith(`_${key}`));
    if (found) return found.value;
  }
  return fallback;
}

function knob(event: BlockEvent | LoopEvent, key: string, fallback: number): number {
  return Math.max(0, Math.min(1, read(event.params, [key], fallback)));
}

/** Kick 32–180 Hz, snare 140–900, hat 250–4000, perc 70–2500. The knob is the pitch, not the MIDI note. */
export function drumPitchHz(lane: number, unit: number): number {
  const u = Math.max(0, Math.min(1, unit));
  const span = (lo: number, hi: number) => lo * (hi / lo) ** u;
  if (lane === 1) return span(140, 900);
  if (lane === 2) return span(250, 4000);
  if (lane === 3) return span(70, 2500);
  return span(32, 180);
}

function squaredSeconds(unit: number, lo: number, span: number): number {
  const u = Math.max(0, Math.min(1, unit));
  return lo + u * u * span;
}

export function kickDecaySeconds(unit: number): number {
  return squaredSeconds(unit, 0.03, 1.37);
}

export function bendTimeSeconds(unit: number): number {
  return squaredSeconds(unit, 0.008, 0.392);
}

export function snareBodyDecaySeconds(unit: number): number {
  return squaredSeconds(unit, 0.04, 0.76);
}

export function snareNoiseDecaySeconds(unit: number): number {
  return squaredSeconds(unit, 0.02, 0.58);
}

export function hatDecaySeconds(unit: number): number {
  return squaredSeconds(unit, 0.02, 1);
}

export function percDecaySeconds(unit: number): number {
  return squaredSeconds(unit, 0.03, 1.2);
}

/** The 808/909 shelf is the octave pair. It carries a short drop; wood and metal stay put. */
function snarePitchBend(body: number): { bend: number; bendTime: number } {
  const distance = Math.abs(body - 0.28);
  if (distance >= 0.1) return { bend: 0, bendTime: 0.02 };
  return { bend: 0.4 * (1 - distance / 0.1), bendTime: 0.02 };
}

const FM_STOPS = [1, 1.5, 2, 3, 4, 5, 7];
const FM_CENTER = [0.06, 0.21, 0.36, 0.51, 0.66, 0.81, 0.96];

/** Plateaus around 1, 1.5, 2, 3, 4, 5 and 7. A step of 0.05 stays on the same shelf. */
export function fmRatioOf(unit: number): number {
  const u = Math.max(0, Math.min(1, unit));
  for (let i = 0; i < FM_STOPS.length; i++) {
    if (Math.abs(u - FM_CENTER[i]) <= 0.055) return FM_STOPS[i];
  }
  if (u <= FM_CENTER[0]) return FM_STOPS[0];
  for (let i = 0; i < FM_STOPS.length - 1; i++) {
    const left = FM_CENTER[i] + 0.055;
    const right = FM_CENTER[i + 1] - 0.055;
    if (u <= FM_CENTER[i + 1]) {
      if (u <= left) return FM_STOPS[i];
      if (u >= right) return FM_STOPS[i + 1];
      const f = (u - left) / (right - left);
      const s = f * f * (3 - 2 * f);
      return FM_STOPS[i] * (1 - s) + FM_STOPS[i + 1] * s;
    }
  }
  return FM_STOPS[FM_STOPS.length - 1];
}

function fade(u: number, a: number, b: number): number {
  if (u <= a) return 0;
  if (u >= b) return 1;
  const x = (u - a) / (b - a);
  return x * x * (3 - 2 * x);
}

function lerpStops(stops: readonly number[], t: number): number {
  const n = stops.length;
  const u = Math.max(0, Math.min(1, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(u));
  const f = u - i;
  return stops[i] * (1 - f) + stops[i + 1] * f;
}

function percNoiseAmt(material: number): number {
  return lerpStops([0.14, 0.2, 0.1, 0.03, 0.07, 0.04], material);
}

function percTone(material: number): number {
  return lerpStops([0.22, 0.35, 0.4, 0.62, 0.75, 0.7], material);
}

interface Spectrum {
  r2: number;
  a2: number;
  r3: number;
  a3: number;
  shape: number;
  fm: number;
}

const KICK_CENTER = [0.08, 0.28, 0.5, 0.78, 0.96];
const SNARE_CENTER = [0.08, 0.28, 0.5, 0.75, 0.92];
const PERC_CENTER = [0.08, 0.24, 0.42, 0.58, 0.74, 0.92];

function shelfSpec(table: readonly number[], centers: readonly number[], t: number): Spectrum {
  const row = (index: number): Spectrum => {
    const o = index * 6;
    return {
      r2: table[o], a2: table[o + 1], r3: table[o + 2], a3: table[o + 3], shape: table[o + 4], fm: table[o + 5],
    };
  };
  const u = Math.max(0, Math.min(1, t));
  if (u <= centers[0]) return row(0);
  for (let i = 0; i < centers.length - 1; i++) {
    if (u > centers[i + 1]) continue;
    const left = centers[i] + 0.06;
    const right = centers[i + 1] - 0.06;
    if (right <= left || u <= left) return row(i);
    if (u >= right) return row(i + 1);
    const f = (u - left) / (right - left);
    const s = f * f * (3 - 2 * f);
    const a = row(i);
    const b = row(i + 1);
    const m = (x: number, y: number) => x * (1 - s) + y * s;
    return { r2: m(a.r2, b.r2), a2: m(a.a2, b.a2), r3: m(a.r3, b.r3), a3: m(a.a3, b.a3), shape: m(a.shape, b.shape), fm: m(a.fm, b.fm) };
  }
  return row(centers.length - 1);
}

const KICK_SPEC = [
  2, 0, 3, 0, 0, 0,
  1.59, 0.48, 2.2, 0.14, 0.1, 0,
  3, 0.34, 5, 0.16, 0.22, 0,
  3.4, 0.95, 5.2, 0.62, 0.08, 0,
  2, 0.28, 3.2, 0.2, 0.96, 0,
];

const SNARE_SPEC = [
  2, 0.02, 3, 0, 0, 0,
  2, 0.92, 4, 0.08, 0, 0,
  2.29, 0.58, 3.71, 0.36, 0.1, 0,
  2.76, 0.64, 5.4, 0.42, 0.12, 0.45,
  1.41, 0.3, 2, 0.18, 0.2, 1.7,
];

const PERC_SPEC = [
  1.7, 0.36, 2.4, 0.1, 0.05, 0,
  2.3, 0.52, 3.6, 0.3, 0.08, 0,
  1.48, 0.88, 2.2, 0.42, 0.04, 0,
  2, 0.48, 2.98, 0.58, 0.06, 0.35,
  2.71, 0.72, 4.2, 0.52, 0.1, 0.55,
  1, 0.12, 1, 0, 0.12, 2.5,
];

function wrapPhase(phase: number): number {
  if (phase < TWO_PI) return phase;
  return phase - TWO_PI * Math.floor(phase / TWO_PI);
}

function tonalBody(drum: DrumVoice, freq: number): { mid: number; side: number } {
  const spec = drum.lane === 0
    ? shelfSpec(KICK_SPEC, KICK_CENTER, drum.body)
    : drum.lane === 1
      ? shelfSpec(SNARE_SPEC, SNARE_CENTER, drum.body)
      : shelfSpec(PERC_SPEC, PERC_CENTER, drum.body);
  let a2 = spec.a2;
  let a3 = spec.a3;
  if (drum.lane === 1) {
    const pair = 0.4 + drum.tone * 0.95;
    const fall = Math.max(drum.env, 1e-4) ** 0.7;
    a2 *= pair * fall;
    a3 *= pair * (0.35 + drum.tone) * fall * fall;
  }
  let dull = 1;
  if (drum.damp > 0.001) {
    const e = Math.max(drum.env, 1e-4);
    dull = e ** (1 + drum.damp * 6);
    a2 *= dull;
    a3 *= dull * dull;
  }
  const inc = (TWO_PI * freq) / SAMPLE_RATE;
  let index = (drum.fm * 5 + spec.fm) * dull;
  let fmMix = index <= 0 ? 0 : Math.min(1, index / 0.8);
  if (drum.lane === 3) {
    const env = Math.max(drum.env, 1e-4);
    const held = drum.damp > 0.001 ? env ** (drum.damp * 1.5) : 1;
    const user = drum.fm ** 0.55 * 5.5;
    index = user * (0.15 + 0.85 * held) + spec.fm * dull;
    fmMix = index <= 0 ? 0 : Math.min(1, index / 0.65);
  }
  const ratio = spec.r3 * (1 - fmMix) + drum.ratio * fmMix;
  drum.phase0 = wrapPhase(drum.phase0 + inc);
  drum.phase1 = wrapPhase(drum.phase1 + inc * spec.r2);
  drum.phase2 = wrapPhase(drum.phase2 + inc * ratio);
  const p1 = Math.sin(drum.phase1);
  const p2 = Math.sin(drum.phase2);
  const sine = Math.sin(drum.phase0);
  const bent = Math.sin(drum.phase0 + p2 * index);
  let x = sine * (1 - fmMix) + bent * fmMix + p1 * a2 * (1 - fmMix * 0.45) + p2 * a3 * (1 - fmMix);
  if (drum.lane === 3) x += p2 * fmMix * 0.2;
  if (spec.shape > 0.001) {
    const shaped = Math.tanh(x * (1 + spec.shape * 7));
    x += (shaped - x) * spec.shape;
  }
  const gain = drum.lane === 0 ? 0.85 : drum.lane === 1 ? 0.55 : 0.6;
  return { mid: x * gain, side: 0 };
}

function hatBody(drum: DrumVoice, freq: number): { mid: number; side: number } {
  const m = Math.max(0, Math.min(1, drum.body));
  const ring = drum.ring;
  const lo = [1, 2.02, 2.97, 4.05];
  const hi = [1, 1.47, 2.31, 3.73];
  const gain = m <= 0.06 ? 0 : (m - 0.06) / 0.94;
  const inc = (TWO_PI * freq) / SAMPLE_RATE;
  const ratio = (i: number) => lo[i] * (1 - m) + hi[i] * m;
  drum.phase0 = wrapPhase(drum.phase0 + inc * ratio(0));
  drum.phase1 = wrapPhase(drum.phase1 + inc * ratio(1));
  drum.phase2 = wrapPhase(drum.phase2 + inc * ratio(2));
  drum.phase3 = wrapPhase(drum.phase3 + inc * ratio(3));
  const s0 = Math.sin(drum.phase0) * 0.9 * gain;
  const s1 = Math.sin(drum.phase1) * 0.72 * gain * (1 - ring * 0.35);
  const s2 = Math.sin(drum.phase2) * 0.5 * gain * (1 - ring * 0.6);
  const s3 = Math.sin(drum.phase3) * 0.36 * gain * (1 - ring * 0.8);
  return { mid: (s0 + s1 + s2 + s3) * 0.42, side: 0 };
}

function poleCoef(hz: number): number {
  return 1 - Math.exp((-TWO_PI * hz) / SAMPLE_RATE);
}

function noiseSample(engine: Engine, drum: DrumVoice): number {
  const white = rng(engine);
  if (drum.lane === 1) {
    const tone = Math.max(0, Math.min(1, drum.tone));
    const sounded = Math.max(40, drum.freq * 2 ** (drum.bend * drum.pitchEnv));
    const center = sounded * (4.5 * 4 ** tone);
    const low = Math.max(140, Math.min(5000, center * 0.5));
    const high = Math.min(14000, Math.max(low * 2, center * 2.4));
    drum.nlp += (white - drum.nlp) * poleCoef(high);
    drum.nhp += (drum.nlp - drum.nhp) * poleCoef(low);
    return (drum.nlp - drum.nhp) * drum.noise * (3.6 + tone * 2.2);
  }
  const tilt = Math.max(0, Math.min(1, drum.tone));
  drum.nlp += (white - drum.nlp) * (0.04 + tilt * 0.5);
  drum.nhp += (white - drum.nhp) * (0.03 + tilt * 0.45);
  const high = white - drum.nhp;
  return (drum.nlp * (1 - tilt) + high * tilt) * drum.noise;
}

function transientSample(engine: Engine, drum: DrumVoice): number {
  const u = drum.click;
  const env = drum.clickEnv;
  drum.clickEnv *= drum.clickK;
  const burst = rng(engine);
  if (u < 0.001 || env < 1e-5) return 0;
  if (drum.lane === 1) {
    const tickW = 1 - fade(u, 0.12, 0.62);
    const pulseW = fade(u, 0.08, 0.55);
    const crackHz = 900 * (7500 / 900) ** u;
    const coef = poleCoef(crackHz);
    drum.phase3 += (burst - drum.phase3) * coef;
    const crack = drum.phase3 * (1 - u * 0.7) + burst * (u * 0.7);
    const tickHz = 600 + u * 3400;
    drum.clickPhase = wrapPhase(drum.clickPhase + (TWO_PI * tickHz) / SAMPLE_RATE);
    const tick = Math.sin(drum.clickPhase);
    const sharp = env ** (1 + u * 0.8);
    const level = 0.75 + u * 0.45;
    return (tick * tickW * 0.8 + crack * pulseW * 2.6) * level * sharp;
  }
  if (drum.lane === 2) {
    const sharp = env ** (0.5 + u);
    return burst * u * 1.8 * sharp;
  }
  const tickW = 1 - fade(u, 0.12, 0.5);
  const pulseW = fade(u, 0.15, 0.45) * (1 - fade(u, 0.55, 0.9));
  const chirpW = fade(u, 0.4, 0.8);
  drum.clickPhase = wrapPhase(drum.clickPhase + (TWO_PI * (900 + 5200 * env)) / SAMPLE_RATE);
  const chirp = Math.sin(drum.clickPhase);
  const tick = Math.sin(drum.clickPhase * 0.45);
  return (tick * tickW + burst * env * env * pulseW + chirp * chirpW) * u * 1.15 * env;
}

function drumIndex(lane: LaneId): number {
  if (lane === "snare") return 1;
  if (lane === "hat") return 2;
  if (lane === "perc") return 3;
  return 0;
}

function rng(engine: Engine): number {
  engine.noise = (Math.imul(engine.noise, 1664525) + 1013904223) >>> 0;
  return engine.noise / 4294967296 * 2 - 1;
}

function emptyDrum(): DrumVoice {
  return {
    on: false, lane: 0, phase0: 0, phase1: 0, phase2: 0, phase3: 0, clickPhase: 0,
    env: 0, noiseEnv: 0, pitchEnv: 1, clickEnv: 0, age: 0, freq: 0,
    decay: 0.2, noiseDecay: 0.05, bendTime: 0.08, bend: 0, body: 0, noise: 0, tone: 0.3,
    click: 0, drive: 0, fm: 0, ratio: 1, ring: 0, pos: 0.5, damp: 0,
    cutoff: 0.5, resonance: 0, reverb: 0, delay: 0, nlp: 0, nhp: 0, flt: 0, band: 0, loop: 0,
    envK: 1, noiseK: 1, pitchK: 1, clickK: 1, gain: 0,
  };
}

function emptyNote(): NoteVoice {
  return {
    on: false, phase: 0, phase2: 0, slave: 0, slave2: 0, env: 0, age: 0, left: 0, freq: 0,
    wave: 0.36, bend: 0, sync: 0, fold: 0, drive: 0, wide: 0,
    cutoff: 0.5, resonance: 0, reverb: 0, delay: 0, attack: 0, release: 0.4, gain: 0,
    low: 0, band: 0, lane: 0, loop: 0, releaseK: 1,
  };
}
