import { SAMPLE_RATE, tickToSample } from "../core/clock.ts";
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

/** Attack, hold for the note, then release. Age 0 is already the first sample of the attack. */
function noteLevel(amp: number, age: number, hold: number, attack: number, releaseSec: number): number {
  if (!(amp > 0) || age < 0) return 0;
  const held = Math.max(1, hold);
  const rise = Math.max(1, attack);
  const tau = Math.max(1, releaseSec * SAMPLE_RATE);
  let env = amp;
  if (age < rise) env = amp * Math.min(1, (age + 1) / rise);
  else if (age >= held) env = amp * Math.exp(-(age - held) / tau);
  if (age >= held && env < amp * FLOOR) return 0;
  return env;
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
    a: 0,
    b: 0,
    c: 0,
    hold: tickToSample(Math.max(1, event.lengthTicks), tempo),
    attack: 1 + unitOf(event, "attack", 0) * 0.2 * SAMPLE_RATE,
    release: 0.04 + release * 1.6,
  };
}

function shapeLevel(shape: EnvelopeShape, age: number): number {
  if (shape.kind === 2) return noteLevel(shape.amp, age, shape.hold, shape.attack, shape.release);
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
  const step = Math.max(1, Math.round(hop));
  let loop = 1;
  for (const event of events) {
    if (event.lane === lane && event.loop > loop) loop = event.loop;
  }
  const values = new Float32Array(Math.max(1, Math.ceil(loop / step)));
  for (const event of events) {
    if (event.lane !== lane) continue;
    const shape = shapeOf(event, tempo);
    const origin = ((event.sample % loop) + loop) % loop;
    const horizon = shapeHorizon(shape, loop);
    for (let age = 0; age <= horizon; age += step) {
      const level = shapeLevel(shape, age);
      if (age > 0 && level <= 0) break;
      const bin = Math.floor(((origin + age) % loop) / step);
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
 * Drums fall from the hit. Notes hold, then release. Silence is 0.
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
