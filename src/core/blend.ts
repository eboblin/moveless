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
 * One pattern becomes the other across the whole morph. No cut at one half.
 * Shared notes lerp. Different pitches on one tick crossfade. Hits that exist
 * on only one side share a ranked slot: the leaving note and the arriving note
 * split one gain, so long notes do not stack. Sound is mixed apart from that.
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
    lanes[lane] = blendLane(fromEvents, toEvents, fromLanes, toLanes, project, lane, t, steps[lane]);
  }
  return {
    lanes,
    harmony: t <= 0 ? fromPhrase.harmony : t >= 1 ? toPhrase.harmony : blendHarmony(fromPhrase.harmony, toPhrase.harmony, t, project.global.seed),
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
  spanSteps: number,
): TimedEvent[] {
  const byNote = lane === "chords";
  const from = group(fromEvents, byNote);
  const to = group(toEvents, byNote);
  const out: TimedEvent[] = [];
  const onlyFrom: TimedEvent[] = [];
  const onlyTo: TimedEvent[] = [];
  const keys = new Set([...from.keys(), ...to.keys()]);
  for (const key of keys) {
    const a = from.get(key) ?? [];
    const b = to.get(key) ?? [];
    if (a.length && b.length && samePitch(a, b, byNote)) {
      const count = Math.max(a.length, b.length);
      for (let i = 0; i < count; i++) {
        const left = a[i];
        const right = b[i];
        if (left && right) {
          out.push(paint(left, lerp(left.velocity, right.velocity, t), lerpTicks(left.lengthTicks, right.lengthTicks, t), left.sound, right.sound, fromLanes, toLanes, project, lane, t));
        } else if (left) onlyFrom.push(left);
        else if (right) onlyTo.push(right);
      }
      continue;
    }
    if (a.length && b.length) {
      for (const event of a) out.push(scaled(event, 1 - t, fromLanes, toLanes, project, lane, t, "from"));
      for (const event of b) out.push(scaled(event, t, fromLanes, toLanes, project, lane, t, "to"));
      continue;
    }
    onlyFrom.push(...a);
    onlyTo.push(...b);
  }
  handoff(out, onlyFrom, onlyTo, fromLanes, toLanes, project, lane, t);
  const capped = capStack(out, fromEvents, toEvents, spanSteps);
  capped.sort((x, y) => x.tick - y.tick || x.note - y.note);
  return capped.filter((event) => event.velocity >= 1 / 127);
}

/** Pull a stacked chord or bass note back so one tick is no louder than the louder end. */
function capStack(blended: TimedEvent[], fromEvents: readonly TimedEvent[], toEvents: readonly TimedEvent[], spanSteps: number): TimedEvent[] {
  if (blended.length < 2) return blended;
  const span = Math.max(1, spanSteps) * SIXTEENTH_TICKS;
  const scale = blended.map(() => 1);
  const marks = new Set<number>();
  for (const event of blended) {
    if (event.tick >= 0 && event.tick < span) marks.add(event.tick);
  }
  for (const tick of marks) {
    const heard = cover(blended, tick);
    const cap = Math.max(cover(fromEvents, tick), cover(toEvents, tick));
    if (heard <= cap + 1e-9 || heard <= 0) continue;
    const ratio = cap / heard;
    blended.forEach((event, index) => {
      if (tick >= event.tick && tick < event.tick + event.lengthTicks) scale[index] = Math.min(scale[index], ratio);
    });
  }
  return blended.map((event, index) => (scale[index] === 1 ? event : { ...event, velocity: event.velocity * scale[index] }));
}

function cover(events: readonly TimedEvent[], tick: number): number {
  let sum = 0;
  for (const event of events) {
    if (tick >= event.tick && tick < event.tick + event.lengthTicks) sum += event.velocity;
  }
  return sum;
}

function samePitch(a: readonly TimedEvent[], b: readonly TimedEvent[], byNote: boolean): boolean {
  if (byNote) return true;
  return a.length === 1 && b.length === 1 && a[0].note === b[0].note;
}

function group(events: readonly TimedEvent[], byNote: boolean): Map<string, TimedEvent[]> {
  const map = new Map<string, TimedEvent[]>();
  for (const event of events) {
    const key = byNote ? `${event.tick}:${event.note}` : String(event.tick);
    const list = map.get(key);
    if (list) list.push(event);
    else map.set(key, [event]);
  }
  return map;
}

/** One slot is one gain. A paired note leaves while its partner arrives. */
function handoff(
  out: TimedEvent[],
  onlyFrom: TimedEvent[],
  onlyTo: TimedEvent[],
  fromLanes: Lanes,
  toLanes: Lanes,
  project: Project,
  lane: LaneId,
  t: number,
): void {
  const fromRanked = rank(onlyFrom, project.global.seed, lane);
  const toRanked = rank(onlyTo, project.global.seed, lane);
  const slots = Math.max(fromRanked.length, toRanked.length);
  const pairs = Math.min(fromRanked.length, toRanked.length);
  for (let i = 0; i < pairs; i++) {
    const leave = fadeOut(i, slots, t);
    const arrive = fadeIn(i, slots, t);
    const fromEvent = fromRanked[i];
    const toEvent = toRanked[i];
    if (fromEvent && leave > 0) out.push(scaled(fromEvent, leave, fromLanes, toLanes, project, lane, t, "from"));
    if (toEvent && arrive > 0) out.push(scaled(toEvent, arrive, fromLanes, toLanes, project, lane, t, "to"));
  }
  for (let i = pairs; i < fromRanked.length; i++) {
    const leave = fadeOut(i, slots, t);
    const event = fromRanked[i];
    if (event && leave > 0) out.push(scaled(event, leave, fromLanes, toLanes, project, lane, t, "from"));
  }
  for (let i = pairs; i < toRanked.length; i++) {
    const arrive = fadeIn(i, slots, t);
    const event = toRanked[i];
    if (event && arrive > 0) out.push(scaled(event, arrive, fromLanes, toLanes, project, lane, t, "to"));
  }
}

function rank(events: TimedEvent[], seed: number, lane: LaneId): TimedEvent[] {
  return events.slice().sort((x, y) => {
    const hx = hash01(seed, lane, "morph", x.tick, x.note);
    const hy = hash01(seed, lane, "morph", y.tick, y.note);
    if (hx !== hy) return hx - hy;
    return x.tick - y.tick || x.note - y.note;
  });
}

function fadeOut(index: number, count: number, t: number): number {
  if (count <= 0) return 0;
  const width = 1 / count;
  const start = index * width;
  if (t <= start) return 1;
  if (t >= start + width) return 0;
  return 1 - (t - start) / width;
}

function fadeIn(index: number, count: number, t: number): number {
  if (count <= 0) return 0;
  const width = 1 / count;
  const start = index * width;
  if (t <= start) return 0;
  if (t >= start + width) return 1;
  return (t - start) / width;
}

function scaled(
  event: TimedEvent,
  gain: number,
  fromLanes: Lanes,
  toLanes: Lanes,
  project: Project,
  lane: LaneId,
  t: number,
  side: "from" | "to",
): TimedEvent {
  return paint(
    event,
    event.velocity * gain,
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

function lerpTicks(from: number, to: number, t: number): number {
  return Math.max(1, Math.round(lerp(from, to, t)));
}

/** Chord names change one region at a time, in hash order, across the whole morph. */
function blendHarmony(from: readonly HarmonicEvent[], to: readonly HarmonicEvent[], t: number, seed: number): HarmonicEvent[] {
  if (!from.length) return to.slice();
  const order = from.map((event, index) => ({ index, rank: hash01(seed, "chords", "harm", event.startTick, index) }));
  order.sort((x, y) => x.rank - y.rank || x.index - y.index);
  const place = new Map(order.map((item, index) => [item.index, index]));
  const count = from.length;
  return from.map((event, index) => {
    const slot = place.get(index) ?? 0;
    if (t < (slot + 1) / count) return event;
    const mid = event.startTick + event.lengthTicks / 2;
    const next = to.find((item) => mid >= item.startTick && mid < item.startTick + item.lengthTicks) ?? to[to.length - 1];
    if (!next) return event;
    return { ...event, root: next.root, quality: next.quality };
  });
}
