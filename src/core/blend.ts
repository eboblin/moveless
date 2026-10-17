import { clamp01, sampleOffset, SIXTEENTH_TICKS, sixteenthSteps, tickToSample, ticksPerBar } from "./clock.ts";
import { evalModulated, soundMacro, withMacro } from "./modulate.ts";
import { macroOffset } from "./pages.ts";
import { isDrum, LANES, type LaneFilter, type LaneId, type LaneSend, type Lanes, type Modulated, type Phrase, type Project, type TimedEvent } from "./types.ts";

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
 * Both phrases are snapshots, tiled into one steady loop. Beats hand over
 * from the end of the bar toward the downbeat as live t rises, and every
 * lane takes the same side for a beat. t = 0 is the source. A locked lane
 * stays on the source. Timbre still follows live t. Pitch stays on the event.
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
    const chosen = project.lock[lane]
      ? fromEvents
      : pickBeats(fromEvents, tile(toPhrase.lanes[lane], toPhrase.steps[lane], steps[lane], tempo), project);
    lanes[lane] = stampLane(
      chosen,
      fromLanes[lane].sound,
      toLanes[lane].sound,
      fromLanes[lane].filter,
      toLanes[lane].filter,
      fromLanes[lane].send,
      toLanes[lane].send,
      project,
      lane,
      t,
    );
  }
  return { lanes, harmony: fromPhrase.harmony, steps };
}

/**
 * Side that owns the downbeat. It stays the source until the downbeat itself
 * crosses, which is the last beat to move.
 */
export function morphBarSide(project: Project): "src" | "dst" {
  const morph = project.morph;
  if (!morph || morph.durationTicks <= 0) return "dst";
  return morph.t > beatRank(0, project.global.bar) ? "dst" : "src";
}

/** Last beat of the bar crosses first. The downbeat crosses last, still before t = 1. */
function beatRank(tick: number, beatsPerBar: number): number {
  const beats = Math.max(1, Math.round(beatsPerBar));
  const bar = ticksPerBar(beats);
  const pos = ((tick % bar) + bar) % bar;
  const beat = Math.min(beats - 1, Math.floor((pos * beats) / bar));
  return (beats - 1 - beat + 0.5) / beats;
}

function tookDestination(project: Project, tick: number): boolean {
  const morph = project.morph;
  if (!morph || morph.durationTicks <= 0) return true;
  return morph.t > beatRank(tick, project.global.bar);
}

function pickBeats(fromEvents: readonly TimedEvent[], toEvents: readonly TimedEvent[], project: Project): TimedEvent[] {
  const out: TimedEvent[] = [];
  for (const event of fromEvents) {
    if (!tookDestination(project, event.tick)) out.push(event);
  }
  for (const event of toEvents) {
    if (tookDestination(project, event.tick)) out.push(event);
  }
  out.sort((a, b) => a.tick - b.tick || a.note - b.note);
  return out;
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
  filterFrom: LaneFilter,
  filterTo: LaneFilter,
  sendFrom: LaneSend,
  sendTo: LaneSend,
  project: Project,
  lane: LaneId,
  t: number,
): TimedEvent[] {
  const macros = project.lock[lane] ? {} : project.macros;
  return events.map((event) => ({
    ...event,
    sound: stampPitch(event, mixSound(event.step, t, soundFrom, soundTo, macros)),
    filter: {
      cutoff: mixOne(event.step, t, filterFrom.cutoff, filterTo.cutoff, macroOffset("cutoff", macros)),
      resonance: mixOne(event.step, t, filterFrom.resonance, filterTo.resonance, macroOffset("resonance", macros)),
    },
    send: {
      reverb: mixOne(event.step, t, sendFrom.reverb, sendTo.reverb, macroOffset("reverb", macros)),
      delay: mixOne(event.step, t, sendFrom.delay, sendTo.delay, macroOffset("delay", macros)),
    },
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
    out[id] = mixOne(step, t, soundFrom[id], soundTo[id], soundMacro(id, macros));
  }
  return out;
}

function mixOne(step: number, t: number, from: Modulated | undefined, to: Modulated | undefined, macro: number): number {
  const a = heard(from ?? to, macro, step);
  const b = heard(to ?? from, macro, step);
  return clamp01(a + (b - a) * t);
}

function heard(modulated: Modulated | undefined, macro: number, step: number): number {
  if (!modulated) return 0;
  return evalModulated(withMacro(modulated, macro), step);
}
