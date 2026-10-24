import { SIXTEENTH_TICKS, sixteenthSteps, ticksPerBar } from "./clock.ts";
import { clone } from "./clone.ts";
import { phraseStepsOf } from "./events.ts";
import { fieldsOf, getPath, setPath } from "./fields.ts";
import type { MorphKind } from "./pages.ts";
import { isDrum, isPitched, TRANSITION_BARS, type GlobalSettings, type Lanes, type MorphState, type PatternId, type Project, type Scene, type TransitionId } from "./types.ts";

export function quantizeStart(tick: number, transition: TransitionId, beatsPerBar: number): number {
  const grid = transition === "now" ? ticksPerBar(1) / 4 : ticksPerBar(beatsPerBar);
  const mod = ((tick % grid) + grid) % grid;
  return mod === 0 ? tick : tick + (grid - mod);
}

export function morphProgress(morph: MorphState, tick: number): number {
  if (tick < morph.originTick) return 0;
  if (morph.durationTicks <= 0) return 1;
  const t = (tick - morph.originTick) / morph.durationTicks;
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

const fieldMemo = new WeakMap<Lanes, ReturnType<typeof fieldsOf>>();
const LERP_STEPS = 4;

function memoFields(lanes: Lanes) {
  const hit = fieldMemo.get(lanes);
  if (hit) return hit;
  const fields = fieldsOf(lanes);
  fieldMemo.set(lanes, fields);
  return fields;
}

/** End of the loop already playing. A boundary under the cursor waits for the next one. */
function switchTick(origin: number, end: number, periodTicks: number): number {
  if (end <= origin) return origin;
  const period = Math.max(1, periodTicks);
  const mod = ((origin % period) + period) % period;
  const next = mod === 0 ? origin + period : origin + (period - mod);
  return next <= end ? next : end;
}

function lerpAt(from: number, to: number, tick: number, origin: number, end: number): number {
  if (tick < origin) return from;
  if (end <= origin || tick >= end) return to;
  const span = end - origin;
  let k = 0;
  for (let i = 1; i <= LERP_STEPS; i++) {
    const ideal = (span * i) / LERP_STEPS;
    const snapped = i === LERP_STEPS ? span : Math.ceil(ideal / SIXTEENTH_TICKS) * SIXTEENTH_TICKS;
    if (tick >= origin + Math.min(span, snapped)) k = i;
  }
  return from + (to - from) * (k / LERP_STEPS);
}

function lanePeriodTicks(start: Lanes, lane: PatternId, global: GlobalSettings): number {
  if (lane === "fx") return ticksPerBar(global.bar);
  if (lane === "chords") return sixteenthSteps(global.phrase, global.bar) * SIXTEENTH_TICKS;
  const steps = phraseStepsOf(start[lane].gen1, start[lane].gen2);
  const span = isDrum(lane) ? steps : Math.max(steps, sixteenthSteps(global.phrase, global.bar));
  return Math.max(1, span) * SIXTEENTH_TICKS;
}

function cycleTicks(start: Lanes, path: string): number {
  const cyclePath = path.endsWith(".cycle") ? path : `${path.slice(0, path.lastIndexOf("."))}.cycle`;
  return Math.max(1, Math.round(getPath(start, cyclePath))) * SIXTEENTH_TICKS;
}

function fieldAt(
  kind: MorphKind,
  from: number,
  to: number,
  tick: number,
  origin: number,
  end: number,
  periodTicks: number,
): number {
  if (tick < origin) return from;
  if (end <= origin || tick >= end) return to;
  if (kind === "lerp") return lerpAt(from, to, tick, origin, end);
  return tick >= switchTick(origin, end, periodTicks) ? to : from;
}

export function mergeLanes(
  start: Lanes,
  target: Lanes,
  current: Lanes,
  tick: number,
  morph: MorphState,
  global: GlobalSettings,
  punched: ReadonlySet<string>,
  lock: Project["lock"],
): Lanes {
  const from = memoFields(start);
  const targetFields = new Map(memoFields(target).map((field) => [field.path, field.value]));
  const origin = morph.originTick;
  const end = origin + Math.max(0, morph.durationTicks);
  const mask = morph.lanes ? new Set(morph.lanes) : null;
  const periods = new Map<PatternId, number>();
  const writes: { path: string; value: number }[] = [];
  const dirty = new Set<PatternId>();
  for (const field of from) {
    const lane = field.path.split(".")[0] as PatternId;
    if (lock[lane] || (mask && !mask.has(lane)) || punched.has(field.path)) continue;
    const to = targetFields.get(field.path);
    if (to === undefined) continue;
    let period = periods.get(lane);
    if (period === undefined) {
      period = lanePeriodTicks(start, lane, global);
      periods.set(lane, period);
    }
    const grid = field.path.endsWith(".pattern") || field.path.endsWith(".cycle") ? cycleTicks(start, field.path) : period;
    const value = fieldAt(field.kind, field.value, to, tick, origin, end, grid);
    if (getPath(current, field.path) === value) continue;
    dirty.add(lane);
    writes.push({ path: field.path, value });
  }
  if (dirty.size === 0) return current;
  const next: Lanes = { ...current };
  for (const lane of dirty) copyLane(next, current, lane);
  for (const write of writes) setPath(next, write.path, write.value);
  return next;
}

export function applyMorph(project: Project, tick: number): Project {
  if (!project.morph) return project;
  const target = project.journal.find((scene) => scene.id === project.morph?.targetId);
  if (!target) return { ...project, morph: null };
  const t = morphProgress(project.morph, tick);
  const punched = new Set(project.morph.punched);
  const working = mergeLanes(project.morph.start, target.lanes, project.working, tick, project.morph, project.global, punched, project.lock);
  const done = tick >= project.morph.originTick && t >= 1;
  if (!done) return { ...project, working, morph: { ...project.morph, t } };
  return {
    ...project,
    working,
    morph: null,
    activeSceneId: target.id,
    wanderPreviousTarget: target.id,
  };
}

export function retarget(project: Project, scene: Scene, tick: number, lanes: PatternId[] | null = null): Project {
  const origin = quantizeStart(tick, project.transition, project.global.bar);
  const durationTicks = TRANSITION_BARS[project.transition] * ticksPerBar(project.global.bar);
  const start = clone(project.working);
  return {
    ...project,
    morph: {
      start,
      targetId: scene.id,
      originTick: origin,
      durationTicks,
      punched: [],
      lanes,
      t: 0,
    },
  };
}

function copyLane(into: Lanes, from: Lanes, lane: PatternId): void {
  if (lane === "fx") into.fx = clone(from.fx);
  else if (isDrum(lane)) into[lane] = clone(from[lane]);
  else if (isPitched(lane)) into[lane] = clone(from[lane]);
  else into.chords = clone(from.chords);
}

export function punch(project: Project, path: string, value: number): Project {
  const working = clone(project.working);
  setPath(working, path, value);
  if (!project.morph) return { ...project, working };
  const punched = project.morph.punched.includes(path) ? project.morph.punched : [...project.morph.punched, path];
  return { ...project, working, morph: { ...project.morph, punched } };
}
