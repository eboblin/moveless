import { SAMPLE_RATE, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { evalModulated } from "../core/modulate.ts";
import { LANES, type LaneId } from "../core/types.ts";
import type { EngineParam } from "./map.ts";
import type { BlockEvent, LoopEvent, Motion } from "./schedule.ts";

const TWO_PI = Math.PI * 2;
const DRUM_COUNT = 4;
const NOTE_COUNT = 12;

export interface Engine {
  noise: number;
  drums: DrumVoice[];
  notes: NoteVoice[];
  phrase: LoopEvent[];
  motions: Motion[];
  clock: number;
  tempo: number;
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
  base: number;
  loop: number;
}

interface NoteVoice {
  on: boolean;
  phase: number;
  phase2: number;
  env: number;
  age: number;
  left: number;
  freq: number;
  shape: number;
  detune: number;
  fm: number;
  noise: number;
  cutoff: number;
  resonance: number;
  attack: number;
  release: number;
  width: number;
  gain: number;
  low: number;
  band: number;
  lane: number;
  loop: number;
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
  };
}

/** Store a looping phrase. `reset` starts the audio clock at the downbeat. */
export function loadPhrase(engine: Engine, events: LoopEvent[], tempo: number, reset: boolean, motions: Motion[] = []): void {
  engine.phrase = events;
  engine.motions = motions;
  engine.tempo = tempo;
  if (reset) engine.clock = 0;
}

/** One shared-memory write: a phrase the voice loops on its own sample clock. */
export function packPhrase(events: LoopEvent[], tempo: number, reset: boolean, motions: Motion[] = []): string {
  return `P|${tempo}|${reset ? 1 : 0}|${packPhraseBody(events, motions)}`;
}

export function packPhraseBody(events: LoopEvent[], motions: Motion[] = []): string {
  const body = events.map((event) => {
    const lane = LANES.indexOf(event.lane);
    const params = event.params.map((param) => `${param.id}=${param.value.toFixed(4)}`).join(",");
    return `${event.sample}:${event.loop}:${lane}:${event.note}:${event.velocity}:${event.lengthTicks}:${params}`;
  }).join(";");
  if (!motions.length) return body;
  const tail = motions.map((motion) => {
    const lane = LANES.indexOf(motion.lane);
    return `${lane}:${motion.id}:${motion.value.toFixed(4)}:${Math.round(motion.pattern)}:${Math.round(motion.cycle)}:${motion.amount.toFixed(4)}:${motion.loop}`;
  }).join(";");
  return `${body}#${tail}`;
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
    for (const drum of engine.drums) {
      if (!drum.on) continue;
      const sample = drumSample(engine, drum);
      const pan = Math.max(0, Math.min(1, drum.pan));
      left += sample * (1 - pan);
      right += sample * pan;
    }
    for (const note of engine.notes) {
      if (!note.on) continue;
      const pair = noteSample(engine, note);
      left += pair[0];
      right += pair[1];
    }
    out[i * 2] = soft(left);
    out[i * 2 + 1] = soft(right);
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
  armNote(note, event, samples, loop);
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
  drum.low = 0;
}

function armNote(note: NoteVoice, event: BlockEvent | LoopEvent, samples: number, loop: number): void {
  note.on = true;
  note.phase = 0;
  note.phase2 = 0;
  note.env = 0;
  note.age = 0;
  note.left = samples;
  note.lane = LANES.indexOf(event.lane);
  note.loop = loop;
  note.freq = 440 * 2 ** ((event.note - 69) / 12);
  note.shape = read(event.params, ["osc_shape"], 0.5);
  note.detune = read(event.params, ["osc_detune"], 0.5);
  note.fm = read(event.params, ["osc_fm"], 0);
  note.noise = read(event.params, ["noise"], 0);
  note.cutoff = read(event.params, ["cutoff"], 0.7);
  note.resonance = read(event.params, ["resonance"], 0);
  note.attack = read(event.params, ["attack"], 0);
  note.release = read(event.params, ["decay", "release"], 0.4);
  note.width = read(event.params, ["osc_width"], 0);
  note.gain = event.velocity / 127;
  note.low = 0;
  note.band = 0;
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

  const clickTau = 10 + drum.snap * 160 + (1 - drum.bright) * 260;
  const click = rng(engine) * Math.exp(-drum.age / clickTau) * drum.snap * (0.35 + drum.bright * 1.4);

  const noisy = rng(engine) * drum.noise * (hat ? 0.45 + drum.bright * 0.7 : 1);
  const mixed = bodyOsc * drum.env + noisy * drum.noiseEnv + click;
  const coef = 0.025 + drum.tone * drum.tone * 0.95;
  drum.low += (mixed - drum.low) * coef;
  // Drive is squared so the top of the knob stays the smash zone, not a dead plateau.
  const driven = shapeDrive(drum.low, drum.drive * drum.drive);

  drum.env *= Math.exp(-1 / (Math.max(0.004, drum.decay) * SAMPLE_RATE));
  drum.noiseEnv *= Math.exp(-1 / (Math.max(0.003, drum.noiseDecay) * SAMPLE_RATE));
  drum.age += 1;
  if (drum.env < 0.0008 && drum.noiseEnv < 0.0008 && drum.age > clickTau * 4) drum.on = false;
  return driven;
}

function noteSample(engine: Engine, note: NoteVoice): [number, number] {
  const inc = (TWO_PI * note.freq) / SAMPLE_RATE;
  // FM/reso use a square curve: the old linear*8 died around unit 0.16; this
  // keeps the musical throw across most of the knob and leaves 1.0 as chaos.
  const fm = note.fm * note.fm * 5;
  if (fm > 1e-4) note.phase += inc + Math.sin(note.phase) * fm * inc;
  else note.phase += inc;
  const detOff = note.detune - 0.5;
  const ratio = 1 + detOff * 0.35;
  const primary = wave(note.phase, note.shape);
  const needSecond = Math.abs(detOff) > 1e-3 || note.width > 1e-3;
  let second = 0;
  if (needSecond) {
    note.phase2 += inc * ratio;
    second = wave(note.phase2, note.shape);
  }
  let noisy = primary;
  if (needSecond) noisy += second * 0.35 * Math.abs(detOff) * 2;
  if (note.noise > 1e-3) noisy += rng(engine) * note.noise * 0.85;
  const coef = 0.015 + note.cutoff * note.cutoff * 0.92;
  note.low += (noisy - note.low) * coef;
  const diff = noisy - note.low;
  const reso = note.resonance * note.resonance;
  let resonated = note.low;
  if (reso > 1e-4) {
    note.band += (diff - note.band) * (0.08 + reso * 0.45);
    resonated += note.band * reso * 4;
  } else {
    note.band = 0;
  }
  const attackSamples = 1 + note.attack * 0.2 * SAMPLE_RATE;
  if (note.age < attackSamples) note.env = (note.age + 1) / attackSamples;
  else note.env *= Math.exp(-1 / ((0.04 + note.release * 1.6) * SAMPLE_RATE));
  note.age += 1;
  note.left -= 1;
  // Do not silence during attack: a slow attack starts below 0.0008 and would mute the note.
  if (note.left <= 0 || (note.age >= attackSamples && note.env < 0.0008)) note.on = false;
  const gain = resonated * note.env * note.gain * 0.38;
  const wide = needSecond ? second * note.width * gain * 1.35 : 0;
  return [gain + wide, gain - wide];
}

function wave(phase: number, shape: number): number {
  const wrapped = ((phase % TWO_PI) + TWO_PI) % TWO_PI;
  const saw = wrapped / Math.PI - 1;
  const square = wrapped < Math.PI ? 1 : -1;
  if (shape >= 0.5) {
    const t = (shape - 0.5) * 2;
    return saw * (1 - t) + square * t;
  }
  const sine = Math.sin(wrapped);
  const t = shape * 2;
  return sine * (1 - t) + saw * t;
}

function shapeDrive(sample: number, drive: number): number {
  const gain = 1 + drive * 8;
  const driven = sample * gain;
  return driven / (1 + Math.abs(driven));
}

function follow(engine: Engine): void {
  if (!engine.motions.length) return;
  const pos = engine.clock - 1;
  if (pos < 0) return;
  const span = Math.max(1, tickToSample(SIXTEENTH_TICKS, engine.tempo));
  for (let index = 0; index < engine.drums.length; index++) {
    const drum = engine.drums[index];
    if (!drum.on || drum.loop < 1) continue;
    const step = (pos % drum.loop) / span;
    for (const motion of engine.motions) {
      if (LANES.indexOf(motion.lane) !== index || motion.amount === 0) continue;
      applyDrum(drum, motion, step);
    }
  }
  for (const note of engine.notes) {
    if (!note.on || note.loop < 1) continue;
    const step = (pos % note.loop) / span;
    for (const motion of engine.motions) {
      if (LANES.indexOf(motion.lane) !== note.lane || motion.amount === 0) continue;
      applyNote(note, motion, step);
    }
  }
}

function applyDrum(drum: DrumVoice, motion: Motion, step: number): void {
  const unit = live(motion, step);
  const id = motion.id;
  if (ends(id, "freq")) return;
  if (ends(id, "dcy")) {
    drum.decay = drumDecaySeconds(unit);
    if (drum.lane === 2) drum.noiseDecay = drumNoiseDecaySeconds(unit);
  } else if (ends(id, "nedcy")) drum.noiseDecay = drumNoiseDecaySeconds(unit);
  else if (ends(id, "mix")) drum.noise = unit;
  else if (ends(id, "dist")) drum.drive = unit;
  else if (ends(id, "nfq")) drum.tone = unit;
  else if (ends(id, "pan")) drum.pan = unit;
  else if (ends(id, "mrate")) drum.spread = unit;
  else if (ends(id, "nffrq")) drum.bright = unit;
  else if (ends(id, "atk")) drum.snap = unit;
  else if (ends(id, "mamt")) drum.bend = unit;
  else if (ends(id, "lvl")) drum.body = unit;
}

function applyNote(note: NoteVoice, motion: Motion, step: number): void {
  const unit = live(motion, step);
  const id = motion.id;
  if (id === "osc_shape") note.shape = unit;
  else if (id === "osc_detune") note.detune = unit;
  else if (id === "osc_fm") note.fm = unit;
  else if (id === "noise") note.noise = unit;
  else if (id === "cutoff") note.cutoff = unit;
  else if (id === "resonance") note.resonance = unit;
  else if (id === "attack") note.attack = unit;
  else if (id === "release" || id === "decay") note.release = unit;
  else if (id === "osc_width") note.width = unit;
}

function live(motion: Motion, step: number): number {
  return evalModulated(motion, step);
}

function ends(id: string, suffix: string): boolean {
  return id === suffix || id.endsWith(`_${suffix}`);
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
    snap: 0, bright: 0.4, bend: 0, body: 1, low: 0, base: 0, loop: 0,
  };
}

function emptyNote(): NoteVoice {
  return {
    on: false, phase: 0, phase2: 0, env: 0, age: 0, left: 0, freq: 0, shape: 0, detune: 0.5,
    fm: 0, noise: 0, cutoff: 0.7, resonance: 0, attack: 0, release: 0.4, width: 0, gain: 0,
    low: 0, band: 0, lane: 0, loop: 0,
  };
}
