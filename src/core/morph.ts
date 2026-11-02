import { PPQN, ticksPerBar } from "./clock.ts";
import { clone, copy } from "./clone.ts";
import { fieldsOf, getPath, setPath } from "./fields.ts";
import { isDrum, isPitched, PATTERN_LANES, TRANSITION_BARS, type EuclidGen, type GlobalSettings, type Lanes, type MorphState, type PatternId, type Project, type Scene, type TransitionId } from "./types.ts";

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

/** How a lane crosses its slot. A dip hides the pattern swap. In and out are one-sided. */
export type HandoffKind = "dip" | "in" | "out";

export interface LaneHandoff {
  lane: PatternId;
  kind: HandoffKind;
  startTick: number;
  commitTick: number;
  endTick: number;
}

interface LaneCommit {
  lane: PatternId;
  tick: number;
}

interface MorphPlan {
  lock: Project["lock"];
  target: Lanes;
  bar: number;
  transition: TransitionId;
  punched: string;
  commits: readonly LaneCommit[];
  handoffs: readonly LaneHandoff[];
}

const fieldMemo = new WeakMap<Lanes, ReturnType<typeof fieldsOf>>();
/** Next tick at which this morph writes a lane or lands. Idle ticks return the same project. */
const nextApply = new WeakMap<MorphState, number>();
const plans = new WeakMap<MorphState, MorphPlan>();

const COLOR: readonly PatternId[] = ["fx", "hat", "perc", "snare"];
const SLOW_ORDER: readonly PatternId[] = ["fx", "hat", "perc", "snare", "chords", "lead"];

function memoFields(lanes: Lanes) {
  const hit = fieldMemo.get(lanes);
  if (hit) return hit;
  const fields = fieldsOf(lanes);
  fieldMemo.set(lanes, fields);
  return fields;
}

/** A generator places a hit only when the ring has hits and probability is open. Length 0 is no hits. */
function generatorSpeaks(gen: EuclidGen): boolean {
  const length = Math.max(0, Math.round(gen.length));
  const hits = length > 0 ? Math.min(length, Math.max(0, Math.round(gen.hits))) : 0;
  return hits > 0 && gen.probability > 0;
}

/** Fx has no generators. A voice is silent when every generator is silent. */
function laneSpeaks(lanes: Lanes, lane: PatternId): boolean {
  if (lane === "fx") return true;
  if (lane === "chords") return generatorSpeaks(lanes.chords.gen1);
  if (isDrum(lane) || isPitched(lane)) {
    const part = lanes[lane];
    return generatorSpeaks(part.gen1) || generatorSpeaks(part.gen2);
  }
  return false;
}

function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Heard gain of one lane. The mixer is not involved: this rides on top and is 1 outside the slot. */
export function handoffGain(handoff: LaneHandoff, tick: number): number {
  const span = handoff.endTick - handoff.startTick;
  if (span <= 0) return handoff.kind === "out" ? 0 : 1;
  if (tick <= handoff.startTick) return handoff.kind === "in" ? 0 : 1;
  if (tick >= handoff.endTick) return handoff.kind === "out" ? 0 : 1;
  if (handoff.kind === "in") return smoothstep((tick - handoff.startTick) / span);
  if (handoff.kind === "out") return 1 - smoothstep((tick - handoff.startTick) / span);
  if (tick <= handoff.commitTick) {
    const den = handoff.commitTick - handoff.startTick;
    return den <= 0 ? 0 : 1 - smoothstep((tick - handoff.startTick) / den);
  }
  const den = handoff.endTick - handoff.commitTick;
  return den <= 0 ? 1 : smoothstep((tick - handoff.commitTick) / den);
}

function punchedKey(punched: readonly string[]): string {
  let key = "";
  for (const path of punched) key += key ? `\0${path}` : path;
  return key;
}

function laneMoves(
  start: Lanes,
  targetFields: ReadonlyMap<string, number>,
  lane: PatternId,
  punched: ReadonlySet<string>,
): boolean {
  const prefix = `${lane}.`;
  for (const field of memoFields(start)) {
    if (!field.path.startsWith(prefix) || punched.has(field.path)) continue;
    const to = targetFields.get(field.path);
    if (to !== undefined && field.value !== to) return true;
  }
  return false;
}

/** Color, then chords, then lead, then kick and bass as one joint. Slow gives each lane its own slot. */
function groupsFor(transition: TransitionId, moving: ReadonlySet<PatternId>): PatternId[][] {
  const take = (lane: PatternId) => moving.has(lane);
  const foundation = (["kick", "bass"] as const).filter(take);
  if (transition === "fast") {
    const first = [...COLOR.filter(take), ...((["chords"] as const).filter(take))];
    const second = [...((["lead"] as const).filter(take)), ...foundation];
    return [first, second].filter((group) => group.length > 0);
  }
  if (transition === "slow") {
    const slots: PatternId[][] = [];
    for (const lane of SLOW_ORDER) if (take(lane)) slots.push([lane]);
    if (foundation.length) slots.push([...foundation]);
    return slots;
  }
  const slots: PatternId[][] = [];
  const color = COLOR.filter(take);
  if (color.length) slots.push(color);
  if (take("chords")) slots.push(["chords"]);
  if (take("lead")) slots.push(["lead"]);
  if (foundation.length) slots.push([...foundation]);
  return slots;
}

function allocate(origin: number, end: number, bar: number, beat: number, count: number, fast: boolean): Array<[number, number]> {
  if (count <= 1) return [[origin, end]];
  if (fast) {
    const mid = origin + Math.round((end - origin) / 2 / beat) * beat;
    const split = Math.min(end - beat, Math.max(origin + beat, mid));
    return [[origin, split], [split, end]];
  }
  const bars = Math.max(1, Math.round((end - origin) / bar));
  if (count > bars) {
    const spans: Array<[number, number]> = [];
    let cursor = origin;
    const slice = Math.max(beat, Math.floor((end - origin) / count / beat) * beat);
    for (let i = 0; i < count; i++) {
      const slotEnd = i === count - 1 ? end : Math.min(end, cursor + slice);
      spans.push([cursor, slotEnd]);
      cursor = slotEnd;
    }
    return spans;
  }
  const base = Math.floor(bars / count);
  const extra = bars % count;
  const spans: Array<[number, number]> = [];
  let cursor = origin;
  for (let i = 0; i < count; i++) {
    const n = base + (i >= count - extra ? 1 : 0);
    const slotEnd = i === count - 1 ? end : cursor + n * bar;
    spans.push([cursor, slotEnd]);
    cursor = slotEnd;
  }
  return spans;
}

function dipCommit(start: number, end: number, beat: number, origin: number, joint: boolean): number {
  if (joint) {
    const last = end - beat;
    if (last > start && last < end) return last;
  }
  const mid = start + (end - start) / 2;
  let snapped = origin + Math.round((mid - origin) / beat) * beat;
  if (snapped <= start) snapped = start + beat;
  if (snapped >= end) snapped = end - beat;
  if (snapped <= start || snapped >= end) return mid;
  return snapped;
}

function buildPlan(
  morph: MorphState,
  target: Lanes,
  lock: Project["lock"],
  global: GlobalSettings,
  transition: TransitionId,
): MorphPlan {
  const punched = new Set(morph.punched);
  const mask = morph.lanes ? new Set(morph.lanes) : null;
  const targetFields = new Map(memoFields(target).map((field) => [field.path, field.value]));
  const moving = new Set<PatternId>();
  for (const lane of PATTERN_LANES) {
    if (lock[lane] || (mask && !mask.has(lane))) continue;
    if (laneMoves(morph.start, targetFields, lane, punched)) moving.add(lane);
  }
  const origin = morph.originTick;
  const end = origin + Math.max(0, morph.durationTicks);
  const beat = PPQN;
  const bar = ticksPerBar(global.bar);
  const commits: LaneCommit[] = [];
  const handoffs: LaneHandoff[] = [];
  if (end <= origin) {
    for (const lane of moving) commits.push({ lane, tick: origin });
    return { lock, target, bar: global.bar, transition, punched: punchedKey(morph.punched), commits, handoffs };
  }
  const groups = groupsFor(transition, moving);
  const spans = allocate(origin, end, bar, beat, Math.max(1, groups.length), transition === "fast");
  groups.forEach((group, index) => {
    const [start, slotEnd] = spans[index] ?? [origin, end];
    const joint = transition === "fast" && group.some((lane) => lane === "kick" || lane === "bass") && slotEnd === end && start > origin;
    for (const lane of group) {
      const from = laneSpeaks(morph.start, lane);
      const to = laneSpeaks(target, lane);
      if (from && to) {
        const commitTick = dipCommit(start, slotEnd, beat, origin, joint);
        commits.push({ lane, tick: commitTick });
        handoffs.push({ lane, kind: "dip", startTick: start, commitTick, endTick: slotEnd });
      } else if (!from && to) {
        commits.push({ lane, tick: start });
        handoffs.push({ lane, kind: "in", startTick: start, commitTick: start, endTick: slotEnd });
      } else if (from && !to) {
        commits.push({ lane, tick: slotEnd });
        handoffs.push({ lane, kind: "out", startTick: start, commitTick: slotEnd, endTick: slotEnd });
      } else {
        commits.push({ lane, tick: start });
      }
    }
  });
  commits.sort((a, b) => a.tick - b.tick);
  return { lock, target, bar: global.bar, transition, punched: punchedKey(morph.punched), commits, handoffs };
}

function planFor(project: Project, morph: MorphState, target: Lanes): MorphPlan {
  const cached = plans.get(morph);
  const punched = punchedKey(morph.punched);
  if (
    cached
    && cached.lock === project.lock
    && cached.target === target
    && cached.bar === project.global.bar
    && cached.transition === project.transition
    && cached.punched === punched
  ) return cached;
  const plan = buildPlan(morph, target, project.lock, project.global, project.transition);
  plans.set(morph, plan);
  return plan;
}

/** Fade curves for the voice. Empty when nothing is crossing, including a zero-length cut. */
export function morphHandoffs(project: Project): readonly LaneHandoff[] {
  const morph = project.morph;
  if (!morph || morph.durationTicks <= 0) return [];
  const target = project.journal.find((scene) => scene.id === morph.targetId);
  if (!target) return [];
  return planFor(project, morph, target.lanes).handoffs;
}

function commitLanes(current: Lanes, target: Lanes, lanes: readonly PatternId[], punched: readonly string[]): Lanes {
  if (!lanes.length) return current;
  const next: Lanes = { ...current };
  const keep = new Set(punched);
  for (const lane of lanes) {
    copyLane(next, target, lane);
    const prefix = `${lane}.`;
    for (const path of keep) {
      if (!path.startsWith(prefix)) continue;
      setPath(next, path, getPath(current, path));
    }
  }
  return next;
}

function dueLanes(commits: readonly LaneCommit[], tick: number): PatternId[] {
  const lanes: PatternId[] = [];
  const seen = new Set<PatternId>();
  for (const commit of commits) {
    if (commit.tick > tick || seen.has(commit.lane)) continue;
    seen.add(commit.lane);
    lanes.push(commit.lane);
  }
  return lanes;
}

function nextCommit(commits: readonly LaneCommit[], tick: number, end: number): number {
  for (const commit of commits) if (commit.tick > tick) return commit.tick;
  return end;
}

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
  if (tick < morph.originTick) {
    nextApply.set(morph, morph.originTick);
    return project;
  }
  const plan = planFor(project, morph, target.lanes);
  const lanes = dueLanes(plan.commits, tick);
  const working = commitLanes(project.working, target.lanes, lanes, morph.punched);
  if (tick >= end) {
    nextApply.delete(morph);
    return {
      ...project,
      working,
      morph: null,
      activeSceneId: target.id,
      wanderPreviousTarget: target.id,
    };
  }
  if (working === project.working) {
    nextApply.set(morph, nextCommit(plan.commits, tick, end));
    return project;
  }
  const stepped = { ...morph, t: morphProgress(morph, tick) };
  nextApply.set(stepped, nextCommit(plan.commits, tick, end));
  return { ...project, working, morph: stepped };
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
  if (lane === "fx") into.fx = copy(from.fx);
  else if (isDrum(lane)) into[lane] = copy(from[lane]);
  else if (isPitched(lane)) into[lane] = copy(from[lane]);
  else into.chords = copy(from.chords);
}

export function punch(project: Project, path: string, value: number): Project {
  if (getPath(project.working, path) === value) {
    if (!project.morph || project.morph.punched.includes(path)) return project;
    return { ...project, morph: { ...project.morph, punched: [...project.morph.punched, path] } };
  }
  const dot = path.indexOf(".");
  const head = dot < 0 ? "" : path.slice(0, dot);
  const lane = (PATTERN_LANES as readonly string[]).includes(head) ? head as PatternId : null;
  const working = lane ? { ...project.working } : copy(project.working);
  if (lane) copyLane(working, project.working, lane);
  setPath(working, path, value);
  if (!project.morph) return { ...project, working };
  const punched = project.morph.punched.includes(path) ? project.morph.punched : [...project.morph.punched, path];
  return { ...project, working, morph: { ...project.morph, punched } };
}
