import { ticksPerBar } from "./clock.ts";
import { clone } from "./clone.ts";
import { fieldsOf, getPath, morphValue, setPath } from "./fields.ts";
import { LANES, isDrum, isPitched, TRANSITION_BARS, type LaneId, type Lanes, type MorphState, type Project, type Scene, type TransitionId } from "./types.ts";

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

export function mergeLanes(start: Lanes, target: Lanes, current: Lanes, t: number, punched: ReadonlySet<string>, lock: Project["lock"]): Lanes {
  const next = clone(current);
  const from = fieldsOf(start);
  const targetFields = new Map(fieldsOf(target).map((field) => [field.path, field.value]));
  const currentFields = new Map(fieldsOf(current).map((field) => [field.path, field.value]));
  for (const field of from) {
    const lane = field.path.split(".")[0] as LaneId;
    if (lock[lane] || punched.has(field.path)) {
      setPath(next, field.path, currentFields.get(field.path) ?? field.value);
      continue;
    }
    const to = targetFields.get(field.path);
    if (to === undefined) continue;
    setPath(next, field.path, morphValue(field.kind, field.value, to, t));
  }
  return next;
}

export function applyMorph(project: Project, tick: number): Project {
  if (!project.morph) return project;
  const target = project.journal.find((scene) => scene.id === project.morph?.targetId);
  if (!target) return { ...project, morph: null };
  const t = morphProgress(project.morph, tick);
  const working = mergeLanes(project.morph.start, target.lanes, project.working, t, new Set(project.morph.punched), project.lock);
  const done = tick >= project.morph.originTick && t >= 1;
  if (!done) return { ...project, working, morph: { ...project.morph, t } };
  return { ...project, working, morph: null, activeSceneId: target.id, wanderPreviousTarget: target.id };
}

export function retarget(project: Project, scene: Scene, tick: number): Project {
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
      t: 0,
    },
  };
}

/** Start and target lanes with lock and punch already written into both. */
export function morphEndpoints(project: Project, target: Lanes): { from: Lanes; to: Lanes } {
  const punched = new Set(project.morph?.punched ?? []);
  const start = project.morph?.start ?? project.working;
  return {
    from: pinLanes(start, project.working, punched, project.lock),
    to: pinLanes(target, project.working, punched, project.lock),
  };
}

function pinLanes(base: Lanes, current: Lanes, punched: ReadonlySet<string>, lock: Project["lock"]): Lanes {
  const next = clone(base);
  for (const lane of LANES) {
    if (lock[lane]) copyLane(next, current, lane);
  }
  for (const path of punched) {
    const lane = path.split(".")[0] as LaneId;
    if (lock[lane]) continue;
    setPath(next, path, getPath(current, path));
  }
  return next;
}

function copyLane(into: Lanes, from: Lanes, lane: LaneId): void {
  if (isDrum(lane) || isPitched(lane)) into[lane] = clone(from[lane]);
  else into.chords = clone(from.chords);
}

export function punch(project: Project, path: string, value: number): Project {
  const working = clone(project.working);
  setPath(working, path, value);
  if (!project.morph) return { ...project, working };
  const punched = project.morph.punched.includes(path) ? project.morph.punched : [...project.morph.punched, path];
  return { ...project, working, morph: { ...project.morph, punched } };
}

export function readLanePath(lanes: Lanes, path: string): number {
  return getPath(lanes, path);
}
