import { clamp01, sampleOffset, SIXTEENTH_TICKS, sixteenthSteps, tickToSample, ticksPerBar } from "./clock.ts";
import { evalModulated, withMacro } from "./modulate.ts";
import { isDrum, LANES, type LaneId, type Lanes, type Modulated, type Phrase, type Project, type TimedEvent } from "./types.ts";

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
 * Both phrases are snapshots. The whole bar plays one of them: the source
 * until the bar whose start has reached halfway, then the destination.
 * Every lane takes that same side, so bass still follows the chords it plays
 * with. A locked lane stays on the source. The chosen side is tiled into the
 * steady loop. Timbre still follows live t. Pitch stays on the event.
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
  const source = barSide(project) === "src";
  const lanes = {} as Phrase["lanes"];
  for (const lane of LANES) {
    const useSource = project.lock[lane] || source;
    const phrase = useSource ? fromPhrase : toPhrase;
    const events = tile(phrase.lanes[lane], phrase.steps[lane], steps[lane], tempo);
    lanes[lane] = stampLane(events, fromLanes[lane].sound, toLanes[lane].sound, project, lane, t);
  }
  const harmony = project.lock.chords || source ? fromPhrase.harmony : toPhrase.harmony;
  return { lanes, harmony: harmony.slice(), steps };
}

/** Source through the bar before halfway. From the halfway bar, the destination. */
function barSide(project: Project): "src" | "dst" {
  const morph = project.morph;
  if (!morph || morph.durationTicks <= 0) return "dst";
  const bar = ticksPerBar(project.global.bar);
  const now = morph.originTick + morph.t * Math.max(0, morph.durationTicks);
  const barStart = Math.floor(now / bar) * bar;
  const raw = (barStart - morph.originTick) / morph.durationTicks;
  return raw < 0.5 ? "src" : "dst";
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

function stampLane(
  events: readonly TimedEvent[],
  soundFrom: Record<string, Modulated>,
  soundTo: Record<string, Modulated>,
  project: Project,
  lane: LaneId,
  t: number,
): TimedEvent[] {
  const macros = project.lock[lane] ? {} : project.macros;
  return events.map((event) => ({
    ...event,
    sound: stampPitch(event, mixSound(event.step, t, soundFrom, soundTo, macros)),
  }));
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
