import { clamp01, sampleOffset, SIXTEENTH_TICKS, sixteenthSteps, tickToSample } from "./clock.ts";
import { hash01 } from "./hash.ts";
import { evalModulated, withMacro } from "./modulate.ts";
import { isDrum, LANES, type HarmonicEvent, type LaneId, type Lanes, type Modulated, type Phrase, type Project, type TimedEvent } from "./types.ts";

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
 * Both phrases are snapshots. Each event is kept by its place on the morph:
 * a source event at place p survives with probability 1−p, a destination event
 * with probability p. A kept event is scaled by that same weight, so a
 * destination hit at 10% of the morph plays at 10% of its own velocity.
 * The two sets are united, doubles within half a 64th are
 * dropped, and pitch is the note the owning side already printed. Chord stacks
 * stay at or under the busier side. The picture is fixed for one pass of the
 * blend span, and the voice plays that phrase. Bass and lead pages draw only
 * the generator ring the cursor is in. Timbre still follows t.
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
    const limit = isDrum(lane)
      ? cap
      : Math.max(cap, fromPhrase.steps[lane], toPhrase.steps[lane]);
    steps[lane] = morphWindow(fromPhrase.steps[lane], toPhrase.steps[lane], limit);
  }
  const tempo = project.global.tempo;
  const lanes = {} as Phrase["lanes"];
  for (const lane of LANES) {
    const fromEvents = tile(fromPhrase.lanes[lane], fromPhrase.steps[lane], steps[lane], tempo);
    const toEvents = tile(toPhrase.lanes[lane], toPhrase.steps[lane], steps[lane], tempo);
    const spanTicks = Math.max(1, steps[lane] * SIXTEENTH_TICKS);
    lanes[lane] = blendLane(fromEvents, toEvents, fromLanes[lane].sound, toLanes[lane].sound, project, lane, spanTicks, t);
  }
  return {
    lanes,
    harmony: blendHarmony(fromPhrase.harmony, toPhrase.harmony, project, Math.max(1, steps.chords * SIXTEENTH_TICKS)),
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

/** Half a 64th. Neighboring 64ths stay apart; swung sixteenths are farther. */
const SAME_PLACE_TICKS = 6;

interface Pick {
  event: TimedEvent;
  side: "src" | "dst";
  place: number;
  roll: number;
}

function blendLane(
  fromEvents: readonly TimedEvent[],
  toEvents: readonly TimedEvent[],
  soundFrom: Record<string, Modulated>,
  soundTo: Record<string, Modulated>,
  project: Project,
  lane: LaneId,
  spanTicks: number,
  t: number,
): TimedEvent[] {
  const macros = project.lock[lane] ? {} : project.macros;
  const finish = (events: readonly TimedEvent[]) => events.map((event) => ({
    ...event,
    sound: stampPitch(event, mixSound(event.step, t, soundFrom, soundTo, macros)),
  }));
  if (project.lock[lane]) return finish(fromEvents);
  const src = tag(fromEvents, "src", project, lane, spanTicks);
  const dst = tag(toEvents, "dst", project, lane, spanTicks);
  const all = [...src, ...dst];
  const kept = all.filter(admitted);
  const chosen = lane === "chords" ? capVoices(kept, all) : dedupe(kept);
  chosen.sort((a, b) => a.event.tick - b.event.tick || a.event.note - b.event.note);
  return finish(chosen.map(withMorphLevel));
}

function tag(events: readonly TimedEvent[], side: "src" | "dst", project: Project, lane: LaneId, spanTicks: number): Pick[] {
  const start = passStart(project, spanTicks);
  const span = Math.max(1, spanTicks);
  return events.map((event) => {
    const rel = ((event.tick % span) + span) % span;
    const absolute = start + rel;
    const place = morphPlace(project, absolute);
    return { event, side, place, roll: hash01(project.global.seed, lane, side, absolute, event.note) };
  });
}

/** 0 at the morph start, 1 at its end. A source event is kept with probability 1−place. */
function morphPlace(project: Project, absolute: number): number {
  const morph = project.morph;
  if (!morph || morph.durationTicks <= 0) return 1;
  const raw = (absolute - morph.originTick) / morph.durationTicks;
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}

/** Start of the lane loop the cursor is in. The picture holds until that loop wraps. */
function passStart(project: Project, spanTicks: number): number {
  const morph = project.morph;
  const loop = Math.max(1, spanTicks);
  if (!morph) return 0;
  const now = morph.originTick + morph.t * Math.max(0, morph.durationTicks);
  return Math.floor(now / loop) * loop;
}

function admitted(pick: Pick): boolean {
  return pick.side === "src" ? pick.roll < 1 - pick.place : pick.roll < pick.place;
}

/** Source weight is 1−place, destination weight is place. This is not a lane velocity. */
function withMorphLevel(pick: Pick): TimedEvent {
  const level = pick.side === "src" ? 1 - pick.place : pick.place;
  return { ...pick.event, velocity: pick.event.velocity * level };
}

function keepRank(place: number, side: "src" | "dst", roll: number): number {
  const favored = place < 0.5 ? side === "src" : side === "dst";
  const margin = side === "src" ? 1 - place - roll : place - roll;
  return (favored ? 2 : 0) + margin;
}

function clusterBy<T>(items: readonly T[], tickOf: (item: T) => number, tieOf: (item: T) => number): T[][] {
  const sorted = [...items].sort((a, b) => tickOf(a) - tickOf(b) || tieOf(a) - tieOf(b));
  const groups: T[][] = [];
  for (const item of sorted) {
    const group = groups[groups.length - 1];
    const first = group?.[0];
    if (!group || !first || tickOf(item) - tickOf(first) > SAME_PLACE_TICKS) groups.push([item]);
    else group.push(item);
  }
  return groups;
}

function cluster(picks: readonly Pick[]): Pick[][] {
  return clusterBy(picks, (item) => item.event.tick, (item) => item.event.note);
}

function dedupe(picks: readonly Pick[]): Pick[] {
  return cluster(picks).map((group) => group.reduce((best, item) => (
    keepRank(item.place, item.side, item.roll) > keepRank(best.place, best.side, best.roll) ? item : best
  )));
}

/** A chord may keep at most max(source voices, destination voices) at one place. */
function capVoices(admitted: readonly Pick[], all: readonly Pick[]): Pick[] {
  const out: Pick[] = [];
  for (const place of cluster(all)) {
    const from = place[0]?.event.tick ?? 0;
    const to = place[place.length - 1]?.event.tick ?? from;
    const group = admitted.filter((item) => item.event.tick >= from && item.event.tick <= to);
    const src = new Set(place.filter((item) => item.side === "src").map((item) => item.event.note));
    const dst = new Set(place.filter((item) => item.side === "dst").map((item) => item.event.note));
    const cap = Math.max(src.size, dst.size);
    const ranked = [...group].sort((a, b) => keepRank(b.place, b.side, b.roll) - keepRank(a.place, a.side, a.roll) || a.event.tick - b.event.tick || a.event.note - b.event.note);
    const seen = new Set<number>();
    for (const item of ranked) {
      if (seen.has(item.event.note) || seen.size >= cap) continue;
      seen.add(item.event.note);
      out.push(item);
    }
  }
  return out;
}

function stampPitch(event: TimedEvent, sound: Record<string, number>): Record<string, number> {
  if (event.sound.pitch === undefined) return sound;
  return { ...sound, pitch: event.sound.pitch };
}

function mixSound(
  step: number,
  t: number,
  soundFrom: Record<string, Modulated>,
  soundTo: Record<string, Modulated>,
  macros: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(soundFrom), ...Object.keys(soundTo)])) {
    if (id === "pitch") continue;
    const macro = macros[id] ?? 0;
    const from = heard(soundFrom[id] ?? soundTo[id], macro, step);
    const to = heard(soundTo[id] ?? soundFrom[id], macro, step);
    out[id] = clamp01(from + (to - from) * t);
  }
  return out;
}

function heard(modulated: Modulated | undefined, macro: number, step: number): number {
  if (!modulated) return 0;
  return evalModulated(withMacro(modulated, macro), step);
}

interface ChordPick {
  event: HarmonicEvent;
  side: "src" | "dst";
  place: number;
  roll: number;
}

/** Chord names follow the same place rule, then collapse to one name per spot. */
function blendHarmony(from: readonly HarmonicEvent[], to: readonly HarmonicEvent[], project: Project, spanTicks: number): HarmonicEvent[] {
  if (project.lock.chords) return from.slice();
  const start = passStart(project, spanTicks);
  const span = Math.max(1, spanTicks);
  const picks: ChordPick[] = [];
  for (const event of from) {
    const rel = ((event.startTick % span) + span) % span;
    const place = morphPlace(project, start + rel);
    const roll = hash01(project.global.seed, "chords", "src", start + rel, event.root);
    if (roll < 1 - place) picks.push({ event, side: "src", place, roll });
  }
  for (const event of to) {
    const rel = ((event.startTick % span) + span) % span;
    const place = morphPlace(project, start + rel);
    const roll = hash01(project.global.seed, "chords", "dst", start + rel, event.root);
    if (roll < place) picks.push({ event, side: "dst", place, roll });
  }
  const sorted = clusterBy(picks, (item) => item.event.startTick, (item) => item.event.root);
  return sorted.map((group) => group.reduce((best, item) => (
    keepRank(item.place, item.side, item.roll) > keepRank(best.place, best.side, best.roll) ? item : best
  )).event);
}
