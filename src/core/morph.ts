import { PPQN, SIXTEENTH_TICKS, sixteenthSteps, ticksPerBar } from "./clock.ts";
import { clone } from "./clone.ts";
import { phraseStepsOf } from "./events.ts";
import { fieldsOf, getPath, setPath } from "./fields.ts";
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
/** Next tick at which this morph can change a lane. Idle ticks return the same project. */
const nextApply = new WeakMap<MorphState, number>();
const LERP_STEPS = 4;

function memoFields(lanes: Lanes) {
  const hit = fieldMemo.get(lanes);
  if (hit) return hit;
  const fields = fieldsOf(lanes);
  fieldMemo.set(lanes, fields);
  return fields;
}

/** Generator ring. Bass and lead keep their own cycle; the chord phrase is not the grid. */
function generatorCycleTicks(start: Lanes, lane: PatternId, global: GlobalSettings): number {
  if (lane === "fx") return ticksPerBar(global.bar);
  if (lane === "chords") return sixteenthSteps(global.phrase, global.bar) * SIXTEENTH_TICKS;
  return Math.max(1, phraseStepsOf(start[lane].gen1, start[lane].gen2)) * SIXTEENTH_TICKS;
}

/** Cycle, its half and double, the bar, and the beat. A cycle shorter than a beat keeps that cycle. */
function gridQuanta(cycle: number, beat: number, bar: number): number[] {
  const base = Math.max(1, Math.round(cycle));
  const floor = base < beat ? base : beat;
  const out = [base, base * 2, beat, Math.max(1, Math.round(bar))];
  if (base >= 2) out.push(Math.max(1, Math.floor(base / 2)));
  return out.filter((quantum) => quantum >= floor);
}

/** Transport-aligned boundaries inside the window, plus the landing. */
function gridPoints(origin: number, end: number, quanta: readonly number[]): number[] {
  const points = new Set<number>();
  for (const quantum of quanta) {
    const step = Math.max(1, Math.round(quantum));
    const mod = ((origin % step) + step) % step;
    let tick = mod === 0 ? origin + step : origin + (step - mod);
    let guard = 0;
    while (tick <= end && guard < 8192) {
      if (tick > origin) points.add(tick);
      tick += step;
      guard += 1;
    }
  }
  if (end > origin) points.add(end);
  return [...points].sort((a, b) => a - b);
}

/** Earlier boundary wins a tie, so a slot does not slide toward the landing. */
function snapTick(ideal: number, points: readonly number[]): number {
  let best = points[0] ?? ideal;
  let bestDist = Math.abs(best - ideal);
  for (const point of points) {
    const dist = Math.abs(point - ideal);
    if (dist < bestDist) {
      best = point;
      bestDist = dist;
    }
  }
  return best;
}

function lerpMarks(origin: number, end: number, points: readonly number[]): number[] {
  const span = end - origin;
  const marks: number[] = [];
  for (let step = 1; step <= LERP_STEPS; step += 1) {
    marks.push(snapTick(origin + (span * step) / LERP_STEPS, points));
  }
  return marks;
}

function lerpAt(from: number, to: number, tick: number, marks: readonly number[]): number {
  let step = 0;
  for (let i = 0; i < marks.length; i += 1) {
    if (tick >= marks[i]) step = i + 1;
  }
  return from + (to - from) * (step / LERP_STEPS);
}

/** Pattern and cycle of one modulator share a moment. */
function switchGroup(path: string): string {
  if (path.endsWith(".pattern") || path.endsWith(".cycle")) return path.slice(0, path.lastIndexOf("."));
  return path;
}

function cycleTicks(start: Lanes, path: string): number {
  const cyclePath = path.endsWith(".cycle") ? path : `${path.slice(0, path.lastIndexOf("."))}.cycle`;
  return Math.max(1, Math.round(getPath(start, cyclePath))) * SIXTEENTH_TICKS;
}

interface SwitchSlot {
  cycle: number;
  paths: string[];
}

/** Each changing switch takes an equal share of the window. Pattern and cycle of one modulator share one moment. */
function switchTicks(
  start: Lanes,
  from: ReturnType<typeof fieldsOf>,
  targetFields: ReadonlyMap<string, number>,
  origin: number,
  end: number,
  pointsOf: (cycle: number) => readonly number[],
  cycleOf: (lane: PatternId) => number,
  lock: Project["lock"],
  mask: ReadonlySet<PatternId> | null,
  punched: ReadonlySet<string>,
): Map<string, number> {
  const span = end - origin;
  const slotsByLane = new Map<PatternId, SwitchSlot[]>();
  const slotByKey = new Map<string, SwitchSlot>();
  for (const field of from) {
    if (field.kind !== "switch") continue;
    const lane = field.path.split(".")[0] as PatternId;
    if (lock[lane] || (mask && !mask.has(lane)) || punched.has(field.path)) continue;
    const to = targetFields.get(field.path);
    if (to === undefined || field.value === to) continue;
    const group = switchGroup(field.path);
    const id = `${lane}\0${group}`;
    let slot = slotByKey.get(id);
    if (!slot) {
      slot = { cycle: group === field.path ? cycleOf(lane) : cycleTicks(start, field.path), paths: [] };
      slotByKey.set(id, slot);
      const list = slotsByLane.get(lane) ?? [];
      list.push(slot);
      slotsByLane.set(lane, list);
    }
    slot.paths.push(field.path);
  }
  const when = new Map<string, number>();
  for (const slots of slotsByLane.values()) {
    const count = slots.length;
    for (let i = 0; i < count; i += 1) {
      const at = snapTick(origin + (span * (i + 0.5)) / count, pointsOf(slots[i].cycle));
      for (const path of slots[i].paths) when.set(path, at);
    }
  }
  return when;
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
  const span = end - origin;
  const beat = PPQN;
  const bar = ticksPerBar(global.bar);
  const laneCycle = new Map<PatternId, number>();
  const grids = new Map<number, readonly number[]>();
  const cycleOf = (lane: PatternId): number => {
    let cycle = laneCycle.get(lane);
    if (cycle === undefined) {
      cycle = generatorCycleTicks(start, lane, global);
      laneCycle.set(lane, cycle);
    }
    return cycle;
  };
  const pointsOf = (cycle: number): readonly number[] => {
    const key = Math.max(1, Math.round(cycle));
    let points = grids.get(key);
    if (!points) {
      points = span <= 0 ? [origin] : gridPoints(origin, end, gridQuanta(key, beat, bar));
      grids.set(key, points);
    }
    return points;
  };
  const when = span <= 0 ? new Map<string, number>() : switchTicks(start, from, targetFields, origin, end, pointsOf, cycleOf, lock, mask, punched);
  const marksByLane = new Map<PatternId, readonly number[]>();
  const marksOf = (lane: PatternId): readonly number[] => {
    let marks = marksByLane.get(lane);
    if (!marks) {
      marks = span <= 0 ? [origin, origin, origin, origin] : lerpMarks(origin, end, pointsOf(cycleOf(lane)));
      marksByLane.set(lane, marks);
    }
    return marks;
  };
  const writes: { path: string; value: number }[] = [];
  const dirty = new Set<PatternId>();
  let nextTick = end;
  for (const field of from) {
    const lane = field.path.split(".")[0] as PatternId;
    if (lock[lane] || (mask && !mask.has(lane)) || punched.has(field.path)) continue;
    const to = targetFields.get(field.path);
    if (to === undefined) continue;
    let value = to;
    if (tick < origin) {
      value = field.value;
      if (field.value !== to && origin < nextTick) nextTick = origin;
    } else if (span > 0 && tick < end) {
      if (field.kind === "lerp") {
        const marks = marksOf(lane);
        if (field.value !== to) {
          for (const mark of marks) {
            if (mark > tick && mark < nextTick) nextTick = mark;
          }
        }
        value = lerpAt(field.value, to, tick, marks);
      } else {
        const at = when.get(field.path) ?? end;
        if (field.value !== to && at > tick && at < nextTick) nextTick = at;
        value = tick >= at ? to : field.value;
      }
    }
    if (getPath(current, field.path) === value) continue;
    dirty.add(lane);
    writes.push({ path: field.path, value });
  }
  morphNextTick = nextTick;
  if (dirty.size === 0) return current;
  const next: Lanes = { ...current };
  for (const lane of dirty) copyLane(next, current, lane);
  for (const write of writes) setPath(next, write.path, write.value);
  return next;
}

/** Filled by the last `mergeLanes` call. Idle morph ticks sleep until here. */
let morphNextTick = 0;

export function applyMorph(project: Project, tick: number): Project {
  const morph = project.morph;
  if (!morph) return project;
  const end = morph.originTick + Math.max(0, morph.durationTicks);
  const scheduled = nextApply.get(morph);
  if (scheduled !== undefined && tick < scheduled && tick < end) return project;
  const target = project.journal.find((scene) => scene.id === morph.targetId);
  if (!target) {
    nextApply.delete(morph);
    return { ...project, morph: null };
  }
  const t = morphProgress(morph, tick);
  const punched = new Set(morph.punched);
  const working = mergeLanes(morph.start, target.lanes, project.working, tick, morph, project.global, punched, project.lock);
  const done = tick >= morph.originTick && t >= 1;
  if (!done) {
    if (working === project.working) {
      nextApply.set(morph, morphNextTick);
      return project;
    }
    const stepped = { ...morph, t };
    nextApply.set(stepped, morphNextTick);
    return { ...project, working, morph: stepped };
  }
  nextApply.delete(morph);
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
