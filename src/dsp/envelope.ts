import { clamp01, SAMPLE_RATE, tickToSample } from "../core/clock.ts";
import type { LaneId } from "../core/types.ts";

/** What the envelope reads off a phrase hit. A loop event is a superset of this. */
interface EnvelopeHit {
  sample: number;
  loop: number;
  lane: LaneId;
  velocity: number;
  lengthTicks: number;
  params: readonly { id: string; value: number }[];
}

const FLOOR = 0.02;

function squaredSeconds(unit: number, lo: number, span: number): number {
  const u = Math.max(0, Math.min(1, unit));
  return lo + u * u * span;
}

export function kickDecaySeconds(unit: number): number {
  return squaredSeconds(unit, 0.03, 1.37);
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

function unitOf(event: EnvelopeHit, key: string, fallback: number): number {
  const found = event.params.find((param) => param.id === key || param.id.endsWith(`_${key}`));
  if (!found) return fallback;
  return Math.max(0, Math.min(1, found.value));
}

/** Exponential tail. Quiet once it has fallen under 2% of the hit. */
function decayLevel(amp: number, age: number, seconds: number): number {
  if (!(amp > 0) || !(seconds > 0) || age < 0) return 0;
  const tau = Math.max(1, seconds * SAMPLE_RATE);
  const env = amp * Math.exp(-age / tau);
  if (env < amp * FLOOR) return 0;
  return env;
}

/** How fast the body falls. Front-loaded, and it lands on the target at the end of the gate. */
const MELODY_FALL = 4;

/** Release after the gate, seconds. The bottom of the knob is about 40 ms, the top about 1.6 s. */
export function melodyReleaseSeconds(unit: number): number {
  return 0.04 + clamp01(unit) * 1.6;
}

/**
 * Samples of the rise. Zero is about 2 ms, so a new phase does not click.
 * One is the whole gate: the peak sits on the last sample of the note.
 */
export function melodyAttackSamples(gate: number, attack: number): number {
  const span = Math.max(1, gate);
  const rise = Math.max(0.002 * SAMPLE_RATE, clamp01(attack) * span);
  return rise > span ? span : rise;
}

/** 1 at u = 0, 0 at u = 1. The drop is steep at the start. */
function melodyFall(from: number, to: number, u: number): number {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  const w = Math.exp(-MELODY_FALL * t);
  const w1 = Math.exp(-MELODY_FALL);
  return to + (from - to) * ((w - w1) / (1 - w1));
}

/**
 * Amplitude of one melodic note, before velocity.
 * Age 0 is the first sample. The body lasts `gate` samples: a rise, then a fall
 * that lands on `sustain` at the last sample of the gate. Release is only after that.
 * `origin` skips the rise and falls from that level across the new gate (a glide).
 */
export function melodyLevel(
  age: number,
  gate: number,
  attack: number,
  sustain: number,
  releaseSec: number,
  origin?: number,
): number {
  if (age < 0) return 0;
  const span = Math.max(1, gate);
  const sus = clamp01(sustain);
  const legato = origin !== undefined;
  const rise = legato ? 0 : melodyAttackSamples(span, attack);
  if (age < span) {
    if (!legato && age < rise) return Math.min(1, (age + 1) / rise);
    const from = legato ? clamp01(origin) : 1;
    const start = legato ? 0 : rise;
    const room = Math.max(1, span - start);
    return melodyFall(from, sus, (age - start + 1) / room);
  }
  const end = !legato && rise >= span ? 1 : sus;
  const tau = Math.max(1, releaseSec * SAMPLE_RATE);
  const env = end * Math.exp(-(age - span + 1) / tau);
  if (env < end * FLOOR) return 0;
  return env;
}

/**
 * Filter contour. 1 is open, 0 is the cutoff knob.
 * It opens with the attack and is back at the knob by the end of the same gate.
 * Sustain does not hold it. `origin` falls from the current opening across a new gate.
 */
export function melodyContour(age: number, gate: number, attack: number, origin?: number): number {
  if (age < 0) return 0;
  const span = Math.max(1, gate);
  if (age >= span) return 0;
  if (origin !== undefined) return melodyFall(clamp01(origin), 0, (age + 1) / span);
  const rise = melodyAttackSamples(span, attack);
  if (age < rise) return Math.min(1, (age + 1) / rise);
  if (rise >= span) return 1;
  return melodyFall(1, 0, (age - rise + 1) / (span - rise));
}

/** Sustain knob, or the old pluck inverted. Missing both holds the note. */
export function melodySustain(params: readonly { id: string; value: number }[]): number {
  const sustain = params.find((param) => param.id === "sustain" || param.id.endsWith("_sustain"));
  if (sustain) return clamp01(sustain.value);
  const pluck = params.find((param) => param.id === "pluck" || param.id.endsWith("_pluck"));
  if (pluck) return 1 - clamp01(pluck.value);
  return 1;
}

/** Seconds pulled off the event once, so a hop walk does not re-read params. */
interface EnvelopeShape {
  kind: 0 | 1 | 2;
  amp: number;
  a: number;
  b: number;
  c: number;
  hold: number;
  attack: number;
  release: number;
}

function shapeOf(event: EnvelopeHit, tempo: number): EnvelopeShape {
  const amp = Math.max(0, Math.min(1, event.velocity / 127));
  if (event.lane === "kick") {
    return { kind: 0, amp, a: kickDecaySeconds(unitOf(event, "decay", 0.4)), b: 0, c: 0, hold: 0, attack: 0, release: 0 };
  }
  if (event.lane === "snare") {
    const snap = unitOf(event, "snap", 0.4);
    return {
      kind: 1,
      amp,
      a: snareBodyDecaySeconds(unitOf(event, "bdcy", 0.3)),
      b: snareNoiseDecaySeconds(unitOf(event, "ndcy", 0.3)),
      c: (40 + (1 - snap) ** 1.4 * 700) / SAMPLE_RATE,
      hold: 0,
      attack: 0,
      release: 0,
    };
  }
  if (event.lane === "hat") {
    const body = hatDecaySeconds(unitOf(event, "decay", 0.3)) * (1 + unitOf(event, "ring", 0.3) * 2.8);
    return { kind: 0, amp, a: body, b: 0, c: 0, hold: 0, attack: 0, release: 0 };
  }
  if (event.lane === "perc") {
    return { kind: 0, amp, a: percDecaySeconds(unitOf(event, "decay", 0.4)), b: 0, c: 0, hold: 0, attack: 0, release: 0 };
  }
  const release = unitOf(event, "release", unitOf(event, "decay", 0.4));
  return {
    kind: 2,
    amp,
    a: melodySustain(event.params),
    b: 0,
    c: 0,
    hold: tickToSample(Math.max(1, event.lengthTicks), tempo),
    attack: unitOf(event, "attack", 0),
    release: melodyReleaseSeconds(release),
  };
}

function shapeLevel(shape: EnvelopeShape, age: number): number {
  if (shape.kind === 2) return shape.amp * melodyLevel(age, shape.hold, shape.attack, shape.a, shape.release);
  if (shape.kind === 1) {
    return Math.max(
      decayLevel(shape.amp, age, shape.a),
      decayLevel(shape.amp, age, shape.b),
      decayLevel(shape.amp, age, shape.c),
    );
  }
  return decayLevel(shape.amp, age, shape.a);
}

/** Samples until the tail is under the floor. Capped at eight loops. */
function shapeHorizon(shape: EnvelopeShape, loop: number): number {
  const cap = Math.max(1, loop) * 8;
  let tail: number;
  if (shape.kind === 2) tail = shape.hold + Math.ceil(shape.release * 4 * SAMPLE_RATE);
  else if (shape.kind === 1) tail = Math.ceil(Math.max(shape.a, shape.b, shape.c) * 4 * SAMPLE_RATE);
  else tail = Math.ceil(shape.a * 4 * SAMPLE_RATE);
  if (!(tail > 0)) return 0;
  return tail < cap ? tail : cap;
}

/** One hit, the same seconds the deck sketch paints. Mono: velocity, no pan. */
function hitLevel(event: EnvelopeHit, age: number, tempo: number): number {
  return shapeLevel(shapeOf(event, tempo), age);
}

const ENV_HOP = 128;
/** Same ceiling as the device. The hop doubles until the table fits. */
const ENV_CAP = 8192;

/** One lane, held between hops. Sample 0 and every hop boundary match `laneEnvelopeAt`. */
export interface EnvelopeTable {
  loop: number;
  hop: number;
  values: Float32Array;
}

/**
 * Paint each event forward once. The audio thread and the screen used to scan
 * the whole phrase per sample and per pixel; that overran the block and froze the UI.
 */
export function envelopeTable(events: readonly EnvelopeHit[], lane: LaneId, tempo = 120, hop = ENV_HOP): EnvelopeTable {
  let step = Math.max(1, Math.round(hop));
  let loop = 1;
  for (const event of events) {
    if (event.lane === lane && event.loop > loop) loop = event.loop;
  }
  let n = Math.max(1, Math.ceil(loop / step));
  while (n > ENV_CAP && step < loop && step < 0x40000000) {
    step *= 2;
    n = Math.ceil(loop / step);
  }
  if (n > ENV_CAP) n = ENV_CAP;
  if (n < 1) n = 1;
  const values = new Float32Array(n);
  for (const event of events) {
    if (event.lane !== lane) continue;
    const shape = shapeOf(event, tempo);
    const origin = ((event.sample % loop) + loop) % loop;
    const horizon = shapeHorizon(shape, loop);
    for (let age = 0; age <= horizon; age += step) {
      const level = shapeLevel(shape, age);
      if (age > 0 && level <= 0) break;
      const bin = Math.floor(((origin + age) % loop) / step);
      if (bin < 0 || bin >= n) continue;
      const prev = values[bin] ?? 0;
      if (level > prev) values[bin] = level;
    }
  }
  return { loop, hop: step, values };
}

/** Step-hold. A sample inside a hop keeps the level painted at the hop start. */
export function readEnvelope(table: EnvelopeTable, sample: number): number {
  const loop = table.loop;
  const hop = table.hop;
  if (loop < 1 || hop < 1 || table.values.length < 1) return 0;
  const at = ((sample % loop) + loop) % loop;
  let i = Math.floor(at / hop);
  if (i >= table.values.length) i = table.values.length - 1;
  if (i < 0) i = 0;
  return table.values[i] ?? 0;
}

function eventLevel(event: EnvelopeHit, sample: number, tempo: number): number {
  const loop = Math.max(1, event.loop);
  const origin = ((event.sample % loop) + loop) % loop;
  const at = ((sample % loop) + loop) % loop;
  let since = at - origin;
  if (since < 0) since += loop;
  let best = 0;
  for (let n = 0; n < 8; n++) {
    const level = hitLevel(event, since + n * loop, tempo);
    if (level > best) best = level;
    if (n > 0 && level <= 0) break;
  }
  return best;
}

/**
 * Loudest hit of one lane at `sample`, counted from the start of the loop.
 * Drums fall from the hit. Notes follow the gate, then release. Silence is 0.
 */
export function laneEnvelopeAt(events: readonly EnvelopeHit[], lane: LaneId, sample: number, tempo = 120): number {
  let best = 0;
  for (const event of events) {
    if (event.lane !== lane) continue;
    const level = eventLevel(event, sample, tempo);
    if (level > best) best = level;
  }
  return best;
}
