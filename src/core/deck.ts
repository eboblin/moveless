import { SAMPLE_RATE } from "./clock.ts";

/**
 * Beat-synced deck gestures. The read head is a pure function of musical time,
 * so a brake can be checked without rendering audio. The ring in the voice
 * turns these positions into samples.
 */

export const DECK_GESTURES = [
  "roll",
  "stut",
  "loop",
  "rev",
  "jump",
  "glch",
  "tran",
  "drop",
  "half",
  "dbl",
  "stop",
  "spin",
  "back",
  "scr",
  "hlx",
  "thrw",
] as const;

export type DeckGesture = (typeof DECK_GESTURES)[number];

/** Three-letter pad and the name the header shows while that pad is held. */
export const DECK_PAD: readonly { id: DeckGesture; code: string; title: string }[] = [
  { id: "roll", code: "ROL", title: "BEAT REPEAT" },
  { id: "stut", code: "STU", title: "STUTTER" },
  { id: "loop", code: "LOP", title: "LOOP" },
  { id: "rev", code: "REV", title: "REVERSE" },
  { id: "jump", code: "JMP", title: "RETRIGGER" },
  { id: "glch", code: "GLC", title: "GLITCH" },
  { id: "tran", code: "TRN", title: "TRANSFORM" },
  { id: "drop", code: "DRP", title: "DROP" },
  { id: "half", code: "HLF", title: "HALF TIME" },
  { id: "dbl", code: "DBL", title: "DOUBLE" },
  { id: "stop", code: "STP", title: "VINYL STOP" },
  { id: "spin", code: "SPN", title: "SPIN UP" },
  { id: "back", code: "BCK", title: "BACKSPIN" },
  { id: "scr", code: "SCR", title: "SCRATCH" },
  { id: "hlx", code: "HLX", title: "HELIX" },
  { id: "thrw", code: "THR", title: "DELAY THROW" },
];

/** Top row, then the row under it. Pad index 24 is the first, 16 is the ninth. */
export const DECK_PAD_INDEX: readonly number[] = [
  ...Array.from({ length: 8 }, (_, col) => 24 + col),
  ...Array.from({ length: 8 }, (_, col) => 16 + col),
];

export interface DeckKnobs {
  /** Index into {@link DIV_BEATS}. */
  div: number;
  /** 0 is one sixteenth, 1 is a bar. */
  len: number;
  /** 0 leaves the master alone, 1 is the whole gesture. */
  depth: number;
  /** Index into the brake table: 1/4, 1/2, 1, 2 beats. */
  brake: number;
  /** Scratch curve: baby, tear, flare, orbit. */
  shape: number;
  /** When the gesture grabs the grid: now, division, beat, bar. */
  quant: number;
  /** Transformer duty. */
  duty: number;
  /** Helix pitch rise. */
  ramp: number;
}

export const DIV_BEATS = [2, 1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125] as const;
export const DIV_LABEL = ["1/2", "1/4", "1/8", "1/8T", "1/16", "1/16T", "1/32"] as const;
export const BRAKE_BEATS = [0.25, 0.5, 1, 2] as const;
export const BRAKE_LABEL = ["1/4", "1/2", "1/1", "2/1"] as const;
export const SHAPE_LABEL = ["BAB", "TEA", "FLA", "ORB"] as const;
export const QUANT_LABEL = ["NOW", "DIV", "BEAT", "BAR"] as const;

/** 8 ms. Release slips back to the live head across this. */
export const DECK_FADE = Math.round(0.008 * SAMPLE_RATE);

export type DeckKnobId = keyof DeckKnobs;

/**
 * Knobs that change this gesture. Depth is the wet mix on every one.
 * Stop and spin ignore the grid, so quant is absent there. A division
 * quant also needs the division knob, even when the gesture itself does not.
 */
const GESTURE_KNOBS: Record<DeckGesture, readonly DeckKnobId[]> = {
  roll: ["div", "depth", "quant"],
  stut: ["div", "depth", "quant"],
  loop: ["len", "depth", "quant"],
  rev: ["len", "depth", "quant"],
  jump: ["div", "depth", "quant"],
  glch: ["depth", "quant"],
  tran: ["div", "duty", "depth", "quant"],
  drop: ["depth", "quant"],
  half: ["depth", "quant"],
  dbl: ["div", "depth", "quant"],
  stop: ["brake", "depth"],
  spin: ["brake", "depth"],
  back: ["depth", "quant"],
  scr: ["len", "shape", "depth", "quant"],
  hlx: ["div", "ramp", "depth", "quant"],
  thrw: ["depth", "quant"],
};

/** Null means every knob: no gesture is held, so the strip is the whole deck. */
export function deckKnobsFor(gesture: DeckGesture | null, knobs: DeckKnobs): readonly DeckKnobId[] | null {
  if (!gesture) return null;
  const ids = [...GESTURE_KNOBS[gesture]];
  if (ids.includes("quant") && pick(knobs.quant, 4) === 1 && !ids.includes("div")) ids.push("div");
  return ids;
}

export function defaultDeck(): DeckKnobs {
  return { div: 2, len: 0.5, depth: 1, brake: 2, shape: 0, quant: 2, duty: 0.5, ramp: 0.5 };
}

export function isDeckGesture(value: string): value is DeckGesture {
  return (DECK_GESTURES as readonly string[]).includes(value);
}

function pick(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(value)));
}

function mod(n: number, m: number): number {
  if (m <= 1) return 0;
  const r = n % m;
  return r < 0 ? r + m : r;
}

export function samplesPerBeat(tempo: number): number {
  return (SAMPLE_RATE * 60) / Math.max(1, tempo);
}

export function divSamples(knobs: DeckKnobs, tempo: number): number {
  return Math.max(1, Math.round(DIV_BEATS[pick(knobs.div, DIV_BEATS.length)] * samplesPerBeat(tempo)));
}

/** One sixteenth up to one bar, in samples. */
export function lenSamples(knobs: DeckKnobs, tempo: number, barBeats: number): number {
  const sixteenths = Math.max(1, Math.round(barBeats) * 4);
  const unit = Math.max(0, Math.min(1, knobs.len));
  const n = 1 + Math.min(sixteenths - 1, Math.floor(unit * sixteenths));
  return Math.max(1, Math.round((n * samplesPerBeat(tempo)) / 4));
}

export function brakeSamples(knobs: DeckKnobs, tempo: number): number {
  return Math.max(1, Math.round(BRAKE_BEATS[pick(knobs.brake, BRAKE_BEATS.length)] * samplesPerBeat(tempo)));
}

export function barSamples(tempo: number, barBeats: number): number {
  return Math.max(1, Math.round(Math.max(1, barBeats) * samplesPerBeat(tempo)));
}

/** Grid the gesture waits for. Immediate is one sample, so the press itself is the boundary. */
export function quantSamples(knobs: DeckKnobs, tempo: number, barBeats: number): number {
  const which = pick(knobs.quant, 4);
  if (which === 0) return 1;
  if (which === 1) return divSamples(knobs, tempo);
  if (which === 2) return Math.max(1, Math.round(samplesPerBeat(tempo)));
  return barSamples(tempo, barBeats);
}

/** Next boundary at or after `sample`. The grid is counted from sample 0. */
export function snapUp(sample: number, unit: number): number {
  const u = Math.max(1, Math.round(unit));
  if (u <= 1) return sample;
  const m = mod(sample, u);
  return m === 0 ? sample : sample + (u - m);
}

export interface DeckRead {
  /** Absolute source position. Ignored while `live` is 1. */
  pos: number;
  /** 1 hears the sample just rendered. 0 hears `pos`. */
  live: number;
  gain: number;
  /** 1 also pours the dry master into the delay. */
  throw: number;
  rate: number;
}

export interface DeckMoment {
  gesture: DeckGesture | null;
  /** Sample the finger went down. The voice clock, not the UI tick. */
  down: number;
  /** Sample the finger came up. Null while the gesture is still held. */
  up: number | null;
  now: number;
  tempo: number;
  barBeats: number;
  knobs: DeckKnobs;
  /** Samples already rendered past `now`. 0 means the ring only holds the past. */
  ahead: number;
  seed: number;
}

function identity(now: number): DeckRead {
  return { pos: now, live: 1, gain: 1, throw: 0, rate: 1 };
}

function stopped(now: number): DeckRead {
  return { pos: now, live: 0, gain: 0, throw: 0, rate: 0 };
}

/** Unpowered platter. Rate is exponential and is gone by the end of the brake. */
function brakeRate(elapsed: number, span: number): number {
  if (elapsed >= span) return 0;
  const k = -Math.log(0.01) / span;
  return Math.exp(-k * Math.max(0, elapsed));
}

function brakePos(elapsed: number, span: number, origin: number): number {
  if (elapsed >= span) return origin + span / -Math.log(0.01);
  const k = -Math.log(0.01) / span;
  return origin + (1 - Math.exp(-k * Math.max(0, elapsed))) / k;
}

/**
 * Cubic from a parked head to the live head. Position and rate meet the
 * downbeat together, which a linear ramp from 0 to 1 cannot do.
 */
function spinAt(origin: number, now: number, target: number): DeckRead {
  const span = Math.max(1, target - origin);
  const u = Math.max(0, Math.min(1, (now - origin) / span));
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
  const h01 = -2 * u ** 3 + 3 * u ** 2;
  const h11 = u ** 3 - u ** 2;
  const pos = h00 * origin + h01 * target + h11 * span;
  const d00 = 6 * u ** 2 - 6 * u;
  const d01 = -6 * u ** 2 + 6 * u;
  const d11 = 3 * u ** 2 - 2 * u;
  const rate = (d00 * origin + d01 * target + d11 * span) / span;
  return { pos, live: 0, gain: 1, throw: 0, rate };
}

function nextDownbeat(origin: number, minSpan: number, bar: number): number {
  let target = snapUp(origin + 1, bar);
  if (target - origin < minSpan) target += bar;
  return target;
}

function glitchOrder(seed: number, barIndex: number, count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  let state = (Math.imul(seed + 1, 997) + Math.imul(barIndex + 1, 131)) >>> 0;
  for (let i = count - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order;
}

function loopPos(start: number, now: number, origin: number, slice: number): number {
  return start + mod(now - origin, slice);
}

function scratch(origin: number, now: number, len: number, depth: number, shape: number): DeckRead {
  const span = Math.max(1, len);
  const phase = mod(now - origin, span) / span;
  const reach = Math.max(1, depth) * span * 0.25;
  const which = pick(shape, 4);
  if (which === 2) {
    const gain = phase > 0.35 && phase < 0.65 ? 0 : 1;
    return { pos: origin + phase * reach, live: 0, gain, throw: 0, rate: reach / span };
  }
  const turns = which === 1 ? 2 : 1;
  const wobble = Math.sin(2 * Math.PI * turns * phase);
  const bias = which === 3 ? (phase - 0.5) * 0.35 : 0;
  const offset = (wobble + bias) * reach;
  const rate = ((2 * Math.PI * turns * Math.cos(2 * Math.PI * turns * phase)) / span) * reach;
  return { pos: origin + offset, live: 0, gain: 1, throw: 0, rate };
}

function gestureRead(moment: DeckMoment, gesture: DeckGesture): DeckRead {
  const { knobs, tempo, barBeats, now, down, ahead, seed } = moment;
  const bar = barSamples(tempo, barBeats);
  const div = divSamples(knobs, tempo);
  const len = lenSamples(knobs, tempo, barBeats);
  const immediate = gesture === "stop" || gesture === "spin";
  const origin = immediate ? down : snapUp(down, quantSamples(knobs, tempo, barBeats));
  if (now < origin) return identity(now);

  if (gesture === "stop") {
    const span = brakeSamples(knobs, tempo);
    const elapsed = now - origin;
    const rate = brakeRate(elapsed, span);
    if (rate < 0.02) return stopped(brakePos(span, span, origin));
    return { pos: brakePos(elapsed, span, origin), live: 0, gain: 1, throw: 0, rate };
  }

  if (gesture === "spin") {
    const target = nextDownbeat(origin, brakeSamples(knobs, tempo), bar);
    if (now >= target) return identity(now);
    return spinAt(origin, now, target);
  }

  if (gesture === "roll" || gesture === "stut" || gesture === "hlx") {
    const slice = gesture === "stut" ? Math.max(1, Math.round(div / 2)) : div;
    // The last slice that has already been written. A grid-aligned press would
    // otherwise loop a window that starts at "now" and has not been rendered.
    const start = origin - mod(origin, slice) - slice;
    if (gesture !== "hlx") return { pos: loopPos(start, now, origin, slice), live: 0, gain: 1, throw: 0, rate: 1 };
    const held = now - origin;
    const rise = Math.min(1, held / bar);
    const rate = 1 + Math.max(0, knobs.ramp) * rise * 3;
    const consumed = held <= bar ? held + (Math.max(0, knobs.ramp) * 3 * held * held) / (2 * bar) : held * rate;
    return { pos: start + mod(consumed, slice), live: 0, gain: 1, throw: 0, rate };
  }

  if (gesture === "loop") {
    const start = origin - len;
    return { pos: loopPos(start, now, origin, len), live: 0, gain: 1, throw: 0, rate: 1 };
  }

  if (gesture === "rev") {
    // Prefer the window that has not been heard yet. Without that cushion,
    // reverse the window that just finished. Either one ends on its boundary.
    const future = ahead >= len;
    if (now >= origin + len) return identity(now);
    const windowEnd = future ? origin + len : origin;
    return { pos: windowEnd - (now - origin), live: 0, gain: 1, throw: 0, rate: -1 };
  }

  if (gesture === "jump") {
    const start = origin - mod(origin, bar);
    return { pos: start + mod(now - origin, div), live: 0, gain: 1, throw: 0, rate: 1 };
  }

  if (gesture === "glch") {
    const beat = Math.max(1, Math.round(samplesPerBeat(tempo)));
    const future = ahead >= beat;
    const start = future ? origin : origin - beat;
    const slices = 4;
    const slice = Math.max(1, Math.round(beat / slices));
    const barIndex = Math.floor(origin / bar);
    const order = glitchOrder(seed, barIndex, slices);
    const at = Math.min(slices - 1, Math.floor((now - origin) / slice));
    const into = mod(now - origin, slice);
    return { pos: start + order[at] * slice + into, live: 0, gain: 1, throw: 0, rate: 1 };
  }

  if (gesture === "tran") {
    const duty = 0.05 + Math.max(0, Math.min(1, knobs.duty)) * 0.9;
    const on = mod(now - origin, div) < div * duty;
    return { pos: now, live: 1, gain: on ? 1 : 0, throw: 0, rate: 1 };
  }

  if (gesture === "drop") return { pos: now, live: 1, gain: 0, throw: 0, rate: 1 };

  if (gesture === "half") {
    return { pos: origin + (now - origin) * 0.5, live: 0, gain: 1, throw: 0, rate: 0.5 };
  }

  if (gesture === "dbl") {
    const ran = (now - origin) * 2;
    const head = now + ahead;
    if (origin + ran <= head) return { pos: origin + ran, live: 0, gain: 1, throw: 0, rate: 2 };
    const start = origin - div;
    return { pos: start + mod(ran, div), live: 0, gain: 1, throw: 0, rate: 2 };
  }

  if (gesture === "back") {
    const beat = Math.max(1, samplesPerBeat(tempo));
    const u = (now - origin) / beat;
    if (u >= 1) return identity(now);
    const pos = origin + beat * (2 / Math.PI) * (Math.cos(Math.PI * u) - 1);
    return { pos, live: 0, gain: 1, throw: 0, rate: -2 * Math.sin(Math.PI * u) };
  }

  if (gesture === "scr") return scratch(origin, now, len, knobs.depth, knobs.shape);

  return { pos: now, live: 1, gain: 1, throw: 1, rate: 1 };
}

/** Where the platter reads at `now`. A release crossfades back to the live head. */
export function deckRead(moment: DeckMoment): DeckRead {
  if (!moment.gesture) return identity(moment.now);
  const wet = gestureRead(moment, moment.gesture);
  const up = moment.up;
  if (up === null || moment.now < up) return wet;
  const t = Math.min(1, (moment.now - up) / DECK_FADE);
  const dry = Math.sin(t * Math.PI * 0.5);
  const keep = Math.cos(t * Math.PI * 0.5);
  return {
    pos: wet.pos,
    live: wet.live * keep + dry,
    gain: wet.gain * keep + dry,
    throw: wet.throw * keep,
    rate: wet.rate * keep + dry,
  };
}

export interface DeckPicture {
  /** Sample at the left edge of the strip. The stylus is the midpoint. */
  start: number;
  /** Samples across the strip. Always one bar, so a pad does not zoom. */
  span: number;
  /** Sample under the stylus. */
  head: number;
  /** 0 flattens the groove. */
  gain: number;
}

/**
 * One bar of platter, stylus in the middle. Gestures move `head`, and the
 * groove scrolls under it. The scale stays the bar. Depth is the wet mix in
 * the voice; the strip always shows the full gesture.
 */
export function deckPicture(moment: DeckMoment): DeckPicture {
  const read = deckRead(moment);
  const head = moment.now * read.live + read.pos * (1 - read.live);
  const span = barSamples(moment.tempo, moment.barBeats);
  return { start: head - span / 2, span, head, gain: read.gain };
}

export interface DeckCommand {
  gesture: DeckGesture | null;
  knobs: DeckKnobs;
  warm: boolean;
  seed: number;
  barBeats: number;
}

/** One short record the voice can apply between blocks. `-` is no gesture. */
export function formatDeckCommand(command: DeckCommand): string {
  const knobs = command.knobs;
  const nums = [knobs.div, knobs.len, knobs.depth, knobs.brake, knobs.shape, knobs.quant, knobs.duty, knobs.ramp]
    .map((n, index) => (index === 1 || index === 2 || index === 6 || index === 7 ? n.toFixed(4) : String(Math.round(n))))
    .join(",");
  return `D|${command.gesture ?? "-"}|${nums}|${command.warm ? 1 : 0}|${Math.round(command.seed)}|${Math.max(1, Math.round(command.barBeats))}`;
}

export function parseDeckCommand(text: string): DeckCommand | null {
  if (!text.startsWith("D|")) return null;
  const parts = text.split("|");
  if (parts.length < 6) return null;
  const nums = parts[2].split(",").map((item) => Number(item));
  if (nums.length !== 8 || nums.some((n) => !Number.isFinite(n))) return null;
  const gesture = parts[1] === "-" ? null : isDeckGesture(parts[1]) ? parts[1] : null;
  if (parts[1] !== "-" && gesture === null) return null;
  return {
    gesture,
    knobs: {
      div: nums[0],
      len: nums[1],
      depth: nums[2],
      brake: nums[3],
      shape: nums[4],
      quant: nums[5],
      duty: nums[6],
      ramp: nums[7],
    },
    warm: parts[3] === "1",
    seed: Number(parts[4]) || 0,
    barBeats: Math.max(1, Number(parts[5]) || 4),
  };
}

export function divLabel(knobs: DeckKnobs): string {
  return DIV_LABEL[pick(knobs.div, DIV_LABEL.length)];
}

export function lenLabel(knobs: DeckKnobs, barBeats: number): string {
  const sixteenths = Math.max(1, Math.round(barBeats) * 4);
  const unit = Math.max(0, Math.min(1, knobs.len));
  const n = 1 + Math.min(sixteenths - 1, Math.floor(unit * sixteenths));
  return `${n}/16`;
}
