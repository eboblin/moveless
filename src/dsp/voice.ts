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
  phase: number;
  phase2: number;
  env: number;
  age: number;
  freq: number;
  decay: number;
  noise: number;
  drive: number;
  tone: number;
  pan: number;
  spread: number;
  click: number;
  bend: number;
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

/** Advance the voice clock by real audio frames and retrigger the stored phrase. */
export function renderClock(engine: Engine, frames = 128): Float32Array {
  const tempo = engine.tempo;
  const out = renderFrames(engine, frames, () => {
    for (const event of engine.phrase) {
      const loop = Math.max(1, event.loop);
      if (engine.clock % loop === event.sample) trigger(engine, event, tempo);
    }
    engine.clock += 1;
  });
  return out;
}

function renderFrames(engine: Engine, frames: number, at: (frame: number) => void): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    at(i);
    follow(engine);
    let left = 0;
    let right = 0;
    for (const drum of engine.drums) {
      if (!drum.on) continue;
      const sample = drumSample(engine, drum);
      const angle = drum.pan * Math.PI * 0.5;
      left += sample * Math.cos(angle);
      right += sample * Math.sin(angle);
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
  const base = 440 * 2 ** ((event.note - 69) / 12);
  const dropped = event.lane === "kick" ? 0.5 : 1;
  drum.on = true;
  drum.phase = 0;
  drum.phase2 = 0;
  drum.env = event.velocity / 127;
  drum.age = 0;
  drum.base = base * dropped;
  drum.freq = drum.base * (0.5 + pitch);
  drum.loop = loop;
  drum.decay = 0.04 + read(event.params, ["dcy"], 0.5) * 0.8;
  drum.noise = read(event.params, ["mix"], event.lane === "hat" ? 0.8 : 0.2);
  drum.drive = read(event.params, ["dist"], 0.2);
  drum.tone = read(event.params, ["nfq"], 0.5);
  drum.pan = read(event.params, ["pan"], 0.5);
  drum.spread = read(event.params, ["mrate"], 0);
  drum.click = read(event.params, ["nffrq", "atk"], 0.3);
  drum.bend = read(event.params, ["mamt"], 0);
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
}

function drumSample(engine: Engine, drum: DrumVoice): number {
  const bend = 1 + drum.bend * drum.env * 3;
  const inc = (TWO_PI * drum.freq * bend) / SAMPLE_RATE;
  drum.phase += inc;
  drum.phase2 += inc * (1 + drum.spread * 0.08);
  const body = Math.sin(drum.phase) + Math.sin(drum.phase2) * drum.spread;
  const noise = rng(engine) * drum.noise;
  const click = rng(engine) * Math.exp(-drum.age / (30 + drum.click * 400)) * drum.click;
  const mixed = body * (1 - drum.noise * 0.7) + noise + click;
  const coef = 0.05 + drum.tone * 0.9;
  drum.low += (mixed - drum.low) * coef;
  const driven = shapeDrive(drum.low, drum.drive);
  drum.env *= Math.exp(-1 / (drum.decay * SAMPLE_RATE));
  drum.age += 1;
  if (drum.env < 0.0008) drum.on = false;
  return driven * drum.env;
}

function noteSample(engine: Engine, note: NoteVoice): [number, number] {
  const inc = (TWO_PI * note.freq) / SAMPLE_RATE;
  note.phase += inc + Math.sin(note.phase) * note.fm * inc * 3;
  const ratio = 1 + (note.detune - 0.5) * 0.08;
  note.phase2 += inc * ratio;
  const primary = wave(note.phase, note.shape);
  const second = wave(note.phase2, note.shape);
  const noisy = primary + rng(engine) * note.noise;
  const coef = 0.02 + note.cutoff * note.cutoff * 0.9;
  note.low += (noisy - note.low) * coef;
  const resonated = note.low + (noisy - note.low) * note.resonance;
  const attackSamples = 1 + note.attack * 0.15 * SAMPLE_RATE;
  if (note.age < attackSamples) note.env = (note.age + 1) / attackSamples;
  else note.env *= Math.exp(-1 / ((0.05 + note.release * 1.4) * SAMPLE_RATE));
  note.age += 1;
  note.left -= 1;
  if (note.left <= 0 || note.env < 0.0008) note.on = false;
  const gain = resonated * note.env * note.gain * 0.4;
  return [gain + second * note.width * gain, gain - second * note.width * gain];
}

function wave(phase: number, shape: number): number {
  const wrapped = phase % TWO_PI;
  const sine = Math.sin(wrapped);
  const saw = wrapped / Math.PI - 1;
  return sine * (1 - shape) + saw * shape;
}

function shapeDrive(sample: number, drive: number): number {
  const gain = 1 + drive * 6;
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
    let clickLocked = false;
    for (const motion of engine.motions) {
      if (LANES.indexOf(motion.lane) !== index) continue;
      clickLocked = applyDrum(drum, motion, step, clickLocked);
    }
  }
  for (const note of engine.notes) {
    if (!note.on || note.loop < 1) continue;
    const step = (pos % note.loop) / span;
    for (const motion of engine.motions) {
      if (LANES.indexOf(motion.lane) !== note.lane) continue;
      applyNote(note, motion, step);
    }
  }
}

function applyDrum(drum: DrumVoice, motion: Motion, step: number, clickLocked: boolean): boolean {
  const unit = live(motion, step);
  const id = motion.id;
  if (ends(id, "freq")) drum.freq = drum.base * (0.5 + unit);
  else if (ends(id, "dcy")) drum.decay = 0.04 + unit * 0.8;
  else if (ends(id, "mix")) drum.noise = unit;
  else if (ends(id, "dist")) drum.drive = unit;
  else if (ends(id, "nfq")) drum.tone = unit;
  else if (ends(id, "pan")) drum.pan = unit;
  else if (ends(id, "mrate")) drum.spread = unit;
  else if (ends(id, "nffrq")) {
    drum.click = unit;
    return true;
  } else if (ends(id, "atk") && !clickLocked) drum.click = unit;
  else if (ends(id, "mamt")) drum.bend = unit;
  return clickLocked;
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
  return { on: false, phase: 0, phase2: 0, env: 0, age: 0, freq: 0, decay: 0.2, noise: 0, drive: 0, tone: 0.5, pan: 0.5, spread: 0, click: 0, bend: 0, low: 0, base: 0, loop: 0 };
}

function emptyNote(): NoteVoice {
  return {
    on: false, phase: 0, phase2: 0, env: 0, age: 0, left: 0, freq: 0, shape: 0, detune: 0.5,
    fm: 0, noise: 0, cutoff: 0.7, resonance: 0, attack: 0, release: 0.4, width: 0, gain: 0, low: 0, lane: 0, loop: 0,
  };
}
