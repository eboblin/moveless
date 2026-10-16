import { clamp01, sampleOffset, SIXTEENTH_TICKS, sixteenthSteps, tickToSample } from "./clock.ts";
import { hash01 } from "./hash.ts";
import { evalModulated, withMacro } from "./modulate.ts";
import { LANES, type HarmonicEvent, type LaneId, type Lanes, type Modulated, type Phrase, type Project, type TimedEvent } from "./types.ts";

/** Shared loop for two patterns. Prefers a common multiple that still lands on the target. */
export function morphWindow(stepsA: number, stepsB: number, cap: number): number {
  const a = Math.max(1, Math.round(stepsA));
  const b = Math.max(1, Math.round(stepsB));
  const limit = Math.max(1, Math.round(cap));
  const period = Math.floor((a / gcd(a, b)) * b);
  if (period <= limit) return period;
  if (b >= limit) return limit;
  return Math.max(b, Math.floor(limit / b) * b);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

/**
 * Every lane keeps the events its own probability already produced. During a
 * morph each of those events gets a second chance: the start phrase goes from
 * 1 to 0, the destination from 0 to 1. A note on the same tick in both stays.
 * Timbre glides the whole way.
 */
export function blendPhrases(
  fromPhrase: Phrase,
  toPhrase: Phrase,
  fromLanes: Lanes,
  toLanes: Lanes,
  project: Project,
  t: number,
): Phrase {
  const cap = sixteenthSteps(project.global.phrase, project.global.bar);
  const steps = {} as Phrase["steps"];
  for (const lane of LANES) {
    const limit = lane === "kick" || lane === "snare" || lane === "hat" || lane === "perc"
      ? cap
      : Math.max(cap, fromPhrase.steps[lane], toPhrase.steps[lane]);
    steps[lane] = morphWindow(fromPhrase.steps[lane], toPhrase.steps[lane], limit);
  }
  const aligned = LANES.every((lane) => steps[lane] === fromPhrase.steps[lane]);
  if (t <= 0 && aligned) return fromPhrase;
  const tempo = project.global.tempo;
  const lanes = {} as Phrase["lanes"];
  for (const lane of LANES) {
    const fromEvents = tile(fromPhrase.lanes[lane], fromPhrase.steps[lane], steps[lane], tempo);
    const toEvents = tile(toPhrase.lanes[lane], toPhrase.steps[lane], steps[lane], tempo);
    if (t <= 0) {
      lanes[lane] = fromEvents;
      continue;
    }
    if (t >= 1) {
      lanes[lane] = toEvents;
      continue;
    }
    lanes[lane] = blendLane(fromEvents, toEvents, fromLanes, toLanes, project, lane, t);
  }
  return {
    lanes,
    harmony: blendHarmony(fromPhrase.harmony, toPhrase.harmony, t),
    steps,
  };
}

function tile(events: readonly TimedEvent[], nativeSteps: number, span: number, tempo: number): TimedEvent[] {
  const native = Math.max(1, nativeSteps);
  if (span === native) return events.slice();
  const loopTicks = native * SIXTEENTH_TICKS;
  const spanTicks = span * SIXTEENTH_TICKS;
  const copies = Math.max(1, Math.ceil(span / native));
  const out: TimedEvent[] = [];
  for (let k = 0; k < copies; k++) {
    const shift = k * loopTicks;
    for (const event of events) {
      const wrapped = ((event.tick % loopTicks) + loopTicks) % loopTicks;
      const tick = wrapped + shift;
      if (tick >= spanTicks) continue;
      const sample = tickToSample(tick, tempo);
      out.push({
        ...event,
        tick,
        step: event.step + k * native,
        sample,
        sampleOffset: sampleOffset(sample),
      });
    }
  }
  return out;
}

function blendLane(
  fromEvents: readonly TimedEvent[],
  toEvents: readonly TimedEvent[],
  fromLanes: Lanes,
  toLanes: Lanes,
  project: Project,
  lane: LaneId,
  t: number,
): TimedEvent[] {
  const pool = toEvents.slice();
  const claimed = new Set<number>();
  const out: TimedEvent[] = [];
  for (const event of fromEvents) {
    const twin = takeTwin(pool, claimed, event);
    if (twin >= 0) {
      const other = pool[twin];
      if (!other) continue;
      out.push(paint(event, event.velocity, event.lengthTicks, event.sound, other.sound, fromLanes, toLanes, project, lane, t));
      continue;
    }
    if (admits(project, lane, event, t, "from")) out.push(scaled(event, fromLanes, toLanes, project, lane, t, "from"));
  }
  pool.forEach((event, index) => {
    if (claimed.has(index)) return;
    if (admits(project, lane, event, t, "to")) out.push(scaled(event, fromLanes, toLanes, project, lane, t, "to"));
  });
  out.sort((x, y) => x.tick - y.tick || x.note - y.note);
  return out;
}

/** Same tick and note in both phrases. The two morph chances add up to a sure hit. */
function takeTwin(pool: TimedEvent[], claimed: Set<number>, event: TimedEvent): number {
  for (let i = 0; i < pool.length; i++) {
    if (claimed.has(i)) continue;
    const other = pool[i];
    if (!other || other.tick !== event.tick || other.note !== event.note) continue;
    claimed.add(i);
    return i;
  }
  return -1;
}

/** Start events survive while their roll is at least t. Destination events arrive once t passes the roll. */
function admits(project: Project, lane: LaneId, event: TimedEvent, t: number, side: "from" | "to"): boolean {
  const roll = hash01(project.global.seed, lane, "morph", event.tick, event.note);
  return side === "from" ? roll >= t : roll < t;
}

function scaled(
  event: TimedEvent,
  fromLanes: Lanes,
  toLanes: Lanes,
  project: Project,
  lane: LaneId,
  t: number,
  side: "from" | "to",
): TimedEvent {
  return paint(
    event,
    event.velocity,
    event.lengthTicks,
    side === "from" ? event.sound : null,
    side === "to" ? event.sound : null,
    fromLanes,
    toLanes,
    project,
    lane,
    t,
  );
}

function paint(
  event: TimedEvent,
  velocity: number,
  lengthTicks: number,
  bakedFrom: Record<string, number> | null,
  bakedTo: Record<string, number> | null,
  fromLanes: Lanes,
  toLanes: Lanes,
  project: Project,
  lane: LaneId,
  t: number,
): TimedEvent {
  return {
    ...event,
    velocity,
    lengthTicks,
    sound: mixSound(bakedFrom, bakedTo, event.step, t, fromLanes[lane].sound, toLanes[lane].sound, project.lock[lane] ? {} : project.macros),
  };
}

function mixSound(
  bakedFrom: Record<string, number> | null,
  bakedTo: Record<string, number> | null,
  step: number,
  t: number,
  soundFrom: Record<string, Modulated>,
  soundTo: Record<string, Modulated>,
  macros: Record<string, number>,
): Record<string, number> {
  const ids = new Set([...Object.keys(soundFrom), ...Object.keys(soundTo)]);
  const out: Record<string, number> = {};
  for (const id of ids) {
    const macro = macros[id] ?? 0;
    const from = bakedFrom && id in bakedFrom ? bakedFrom[id] : heard(soundFrom[id] ?? soundTo[id], macro, step);
    const to = bakedTo && id in bakedTo ? bakedTo[id] : heard(soundTo[id] ?? soundFrom[id], macro, step);
    out[id] = clamp01(lerp(from, to, t));
  }
  return out;
}

function heard(modulated: Modulated | undefined, macro: number, step: number): number {
  if (!modulated) return 0;
  return evalModulated(withMacro(modulated, macro), step);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Chord names follow the notes: the start progression until halfway, then the target. */
function blendHarmony(from: readonly HarmonicEvent[], to: readonly HarmonicEvent[], t: number): HarmonicEvent[] {
  return (t < 0.5 ? from : to).slice();
}
