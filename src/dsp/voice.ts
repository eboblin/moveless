import { SAMPLE_RATE, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { defaultSpace } from "../core/defaults.ts";
import { evalModulated } from "../core/modulate.ts";
import { isDrum, LANES, type LaneId, type Space } from "../core/types.ts";
import type { EngineParam } from "./map.ts";
import type { BlockEvent, LoopEvent, Motion } from "./schedule.ts";
import { clearEcho, clearTank, createEcho, createTank, echoSample, tankSample, type Echo, type Tank } from "./space.ts";

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
const P_DCY = 2;
const P_NEDCY = 3;
const P_MIX = 4;
const P_DIST = 5;
const P_NFQ = 6;
const P_PAN = 7;
const P_MRATE = 8;
const P_NFFRQ = 9;
const P_ATK = 10;
const P_MAMT = 11;
const P_LVL = 12;
const P_WAVE = 13;
const P_BEND = 14;
const P_SYNC = 15;
const P_FOLD = 16;
const P_CUTOFF = 17;
const P_RESONANCE = 18;
const P_ATTACK = 19;
const P_RELEASE = 20;
const P_WIDE = 21;
const P_REVERB = 22;
const P_DELAY = 23;
const P_NOTE_DRIVE = 24;

export interface Engine {
  noise: number;
  drums: DrumVoice[];
  notes: NoteVoice[];
  phrase: LoopEvent[];
  motions: Motion[];
  clock: number;
  tempo: number;
  beats: number;
  space: Space;
  tank: Tank;
  echo: Echo;
  /** Pitched-note timing of the phrase last loaded. Same grid must not re-attack. */
  holdSig: string;
  lanes: LaneBox[];
}

interface DrumVoice {
  on: boolean;
  lane: number;
  phase: number;
  phase2: number;
  env: number;
  noiseEnv: number;
  age: number;
  freq: number;
  decay: number;
  noiseDecay: number;
  noise: number;
  drive: number;
  tone: number;
  pan: number;
  spread: number;
  /** `atk` / snap — click amount and length. */
  snap: number;
  /** `nffrq` / click — click brightness. */
  bright: number;
  bend: number;
  /** `lvl` / body — tonal oscillator level. */
  body: number;
  low: number;
  /** Lane filter, after the drum synth. */
  cutoff: number;
  resonance: number;
  reverb: number;
  delay: number;
  flt: number;
  band: number;
  base: number;
  loop: number;
  envK: number;
  noiseK: number;
  clickK: number;
  clickEnv: number;
  clickTau: number;
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
  blend: { value: number; pattern: number; cycle: number; amount: number; t: number } | null;
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
    space: defaultSpace(),
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

export function packPhraseBody(events: LoopEvent[], motions: Motion[] = [], space = ""): string {
  const body = events.map((event) => {
    const lane = LANES.indexOf(event.lane);
    const params = event.params.map((param) => `${param.id}=${param.value.toFixed(4)}`).join(",");
    return `${event.sample}:${event.loop}:${lane}:${event.note}:${event.velocity}:${event.lengthTicks}:${params}`;
  }).join(";");
  if (!motions.length) return space ? `${body}@${space}` : body;
  const tail = motions.map((motion) => {
    const lane = LANES.indexOf(motion.lane);
    const head = `${lane}:${motion.id}:${motion.value.toFixed(4)}:${Math.round(motion.pattern)}:${Math.round(motion.cycle)}:${motion.amount.toFixed(4)}:${motion.loop}`;
    if (!motion.blend) return head;
    const blend = motion.blend;
    return `${head}:${blend.value.toFixed(4)}:${Math.round(blend.pattern)}:${Math.round(blend.cycle)}:${blend.amount.toFixed(4)}:${blend.t.toFixed(4)}`;
  }).join(";");
  const packed = `${body}#${tail}`;
  return space ? `${packed}@${space}` : packed;
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
      const sample = drumSample(engine, drum);
      const pan = Math.max(0, Math.min(1, drum.pan));
      const l = sample * (1 - pan);
      const r = sample * pan;
      left += l;
      right += r;
      revL += l * drum.reverb;
      revR += r * drum.reverb;
      dlyL += l * drum.delay;
      dlyR += r * drum.delay;
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
    const wetR = tankSample(engine.tank, engine.space.reverb, revL, revR);
    const wetD = echoSample(engine.echo, engine.space.delay, engine.beats, engine.tempo, dlyL, dlyR);
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
  const hat = lane === 2;
  const base = 440 * 2 ** ((event.note - 69) / 12);
  const dropped = event.lane === "kick" ? 0.5 : 1;
  const vel = event.velocity / 127;
  drum.on = true;
  drum.lane = lane;
  drum.phase = 0;
  drum.phase2 = 0;
  drum.env = vel;
  drum.noiseEnv = vel;
  drum.age = 0;
  drum.base = base * dropped;
  drum.freq = drum.base * (0.5 + pitch);
  drum.loop = loop;
  const dcyUnit = read(event.params, ["dcy"], 0.5);
  drum.decay = drumDecaySeconds(dcyUnit);
  // Hat has no tail knob — noise used to keep a fixed ~100 ms hiss after body died.
  drum.noiseDecay = drumNoiseDecaySeconds(read(event.params, ["nedcy"], hat ? dcyUnit : 0.45));
  drum.noise = read(event.params, ["mix"], hat ? 0.35 : lane === 1 ? 0.55 : 0.15);
  drum.drive = read(event.params, ["dist"], 0.15);
  drum.tone = read(event.params, ["nfq"], hat ? 0.75 : 0.45);
  drum.pan = read(event.params, ["pan"], 0.5);
  drum.spread = read(event.params, ["mrate"], hat ? 0.4 : 0.1);
  drum.snap = read(event.params, ["atk"], lane === 0 ? 0.35 : hat ? 0.25 : 0.45);
  drum.bright = read(event.params, ["nffrq"], hat ? 0.7 : 0.4);
  drum.bend = read(event.params, ["mamt"], lane === 0 ? 0.55 : lane === 3 ? 0.35 : 0.1);
  drum.body = read(event.params, ["lvl"], hat ? 0.12 : 1);
  drum.cutoff = read(event.params, ["cutoff"], 0.5);
  drum.resonance = read(event.params, ["resonance"], 0);
  drum.reverb = read(event.params, ["reverb"], 0);
  drum.delay = read(event.params, ["delay"], 0);
  drum.low = 0;
  drum.flt = 0;
  drum.band = 0;
  drum.clickEnv = 1;
  refreshDrumEnv(drum);
  refreshClick(drum);
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

function drumSample(engine: Engine, drum: DrumVoice): number {
  const kick = drum.lane === 0;
  const hat = drum.lane === 2;
  const bend = 1 + drum.bend * drum.env * (kick ? 4.5 : 2.2);
  const inc = (TWO_PI * drum.freq * bend) / SAMPLE_RATE;
  const spreadMul = hat ? 1.8 + drum.bright * 2.4 : 0.08 + drum.spread * 0.25;
  drum.phase += inc;
  drum.phase2 += inc * (1 + drum.spread * (hat ? 2.5 : 0.12) + (hat ? drum.bright * 0.55 : 0));
  const bodyOsc = (Math.sin(drum.phase) + Math.sin(drum.phase2) * spreadMul) * drum.body;

  const click = rng(engine) * drum.clickEnv * drum.snap * (0.35 + drum.bright * 1.4);

  const noisy = rng(engine) * drum.noise * (hat ? 0.45 + drum.bright * 0.7 : 1);
  const mixed = bodyOsc * drum.env + noisy * drum.noiseEnv + click;
  const coef = 0.025 + drum.tone * drum.tone * 0.95;
  drum.low += (mixed - drum.low) * coef;
  // Drive is squared so the top of the knob stays the smash zone, not a dead plateau.
  const driven = shapeDrive(drum.low, drum.drive * drum.drive);
  const slot = { low: drum.flt, band: drum.band };
  const filtered = filterSample(slot, driven, drum.cutoff, drum.resonance);
  drum.flt = slot.low;
  drum.band = slot.band;

  drum.env *= drum.envK;
  drum.noiseEnv *= drum.noiseK;
  drum.clickEnv *= drum.clickK;
  drum.age += 1;
  if (drum.env < 0.0008 && drum.noiseEnv < 0.0008 && drum.age > drum.clickTau * 4) drum.on = false;
  return filtered;
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
  if (param === P_DCY) {
    drum.decay = drumDecaySeconds(unit);
    if (drum.lane === 2) drum.noiseDecay = drumNoiseDecaySeconds(unit);
    refreshDrumEnv(drum);
  } else if (param === P_NEDCY) {
    drum.noiseDecay = drumNoiseDecaySeconds(unit);
    refreshDrumEnv(drum);
  } else if (param === P_MIX) drum.noise = unit;
  else if (param === P_DIST) drum.drive = unit;
  else if (param === P_NFQ) drum.tone = unit;
  else if (param === P_PAN) drum.pan = unit;
  else if (param === P_MRATE) drum.spread = unit;
  else if (param === P_NFFRQ) {
    drum.bright = unit;
    refreshClick(drum);
  } else if (param === P_ATK) {
    drum.snap = unit;
    refreshClick(drum);
  }   else if (param === P_MAMT) drum.bend = unit;
  else if (param === P_LVL) drum.body = unit;
  else if (param === P_CUTOFF) drum.cutoff = unit;
  else if (param === P_RESONANCE) drum.resonance = unit;
  else if (param === P_REVERB) drum.reverb = unit;
  else if (param === P_DELAY) drum.delay = unit;
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
  drum.envK = Math.exp(-1 / (Math.max(0.004, drum.decay) * SAMPLE_RATE));
  drum.noiseK = Math.exp(-1 / (Math.max(0.003, drum.noiseDecay) * SAMPLE_RATE));
}

function refreshClick(drum: DrumVoice): void {
  const tau = Math.max(1, 10 + drum.snap * 160 + (1 - drum.bright) * 260);
  drum.clickTau = tau;
  drum.clickK = Math.exp(-1 / tau);
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
  const a = evalModulated({
    value: motion.value,
    pattern: motion.pattern,
    cycle: motion.cycle,
    amount: motion.amount,
  }, step);
  if (!motion.blend) return a;
  const b = evalModulated(motion.blend, step);
  const t = Math.max(0, Math.min(1, motion.blend.t));
  return Math.max(0, Math.min(1, (1 - t) * a + t * b));
}

function bucketMotions(engine: Engine, motions: Motion[]): void {
  engine.lanes = emptyLanes();
  for (const motion of motions) {
    const lane = LANES.indexOf(motion.lane);
    const param = paramOf(motion.id);
    if (lane < 0 || lane >= LANE_COUNT || param === P_NONE || param === P_FREQ) continue;
    const box = engine.lanes[lane];
    const blend = motion.blend ?? null;
    const live = motion.amount !== 0 || (blend !== null && blend.amount !== 0);
    const list = live ? box.live : box.still;
    if (list.length >= LANE_MOTION_CAP) continue;
    list.push({
      param,
      pattern: motion.pattern,
      value: motion.value,
      cycle: motion.cycle,
      amount: motion.amount,
      blend: live ? blend : null,
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
  if (ends(id, "nedcy")) return P_NEDCY;
  if (ends(id, "nffrq")) return P_NFFRQ;
  if (ends(id, "mrate")) return P_MRATE;
  if (ends(id, "mamt")) return P_MAMT;
  if (ends(id, "dcy")) return P_DCY;
  if (ends(id, "mix")) return P_MIX;
  if (ends(id, "dist")) return P_DIST;
  if (ends(id, "nfq")) return P_NFQ;
  if (ends(id, "pan")) return P_PAN;
  if (ends(id, "atk")) return P_ATK;
  if (ends(id, "lvl")) return P_LVL;
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

function steal(engine: Engine): NoteVoice {
  let quiet = engine.notes[0];
  for (const note of engine.notes) {
    if (!note.on) return note;
    if (note.env < quiet.env) quiet = note;
  }
  return quiet;
}

function read(params: EngineParam[], keys: string[], fallback: number): number {
  for (const key of keys) {
    const found = params.find((param) => param.id === key || param.id.endsWith(`_${key}`));
    if (found) return found.value;
  }
  return fallback;
}

/** Squared unit → seconds: low end stays clicky, top still reaches ~1 s. */
function drumDecaySeconds(unit: number): number {
  const u = Math.max(0, Math.min(1, unit));
  return 0.005 + u * u * 0.95;
}

function drumNoiseDecaySeconds(unit: number): number {
  const u = Math.max(0, Math.min(1, unit));
  return 0.004 + u * u * 0.86;
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
    on: false, lane: 0, phase: 0, phase2: 0, env: 0, noiseEnv: 0, age: 0, freq: 0,
    decay: 0.2, noiseDecay: 0.15, noise: 0, drive: 0, tone: 0.5, pan: 0.5, spread: 0,
    snap: 0, bright: 0.4, bend: 0, body: 1, low: 0, cutoff: 0.5, resonance: 0, reverb: 0, delay: 0, flt: 0, band: 0, base: 0, loop: 0,
    envK: 1, noiseK: 1, clickK: 1, clickEnv: 1, clickTau: 10,
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
