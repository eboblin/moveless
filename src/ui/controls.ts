import { clone } from "../core/clone.ts";
import { setDeck } from "../core/journal.ts";
import { punch } from "../core/morph.ts";
import { bindingFor, type Binding } from "../core/pages.ts";
import { setBus, setMacro, setMixer } from "../core/performance.ts";
import { SCALE_IDS, type Bus, type ContextId, type LaneId, type Progression, type Project } from "../core/types.ts";
import type { DetentHold } from "./state.ts";

export function readControl(project: Project, context: ContextId, path: string): number {
  const binding = bindingFor(path);
  if (!binding || binding.store === "lane") return readWorking(project, context === "aux" ? path : `${context}.${path}`);
  return readStored(project, binding);
}

export function writeControl(
  project: Project,
  context: ContextId,
  binding: Binding,
  delta: number,
  hold: DetentHold | null = null,
): { project: Project; hold: DetentHold | null } {
  if (delta === 0) return { project, hold };
  const current = readControl(project, context, binding.path);
  const stepped = stepKnob(current, binding, delta, hold, Date.now());
  return { project: storeControl(project, context, binding, stepped.value), hold: stepped.hold };
}

/** Clicks the encoder must spend on a fresh detent before the value moves off it. */
export const DETENT_CLICKS = 8;
/** After this long on a detent, the next turn leaves with no extra clicks. */
export const DETENT_REST_MS = 500;

/** One encoder message. A detent catches a crossing step and holds until it has rested. */
export function stepKnob(
  current: number,
  binding: Binding,
  delta: number,
  hold: DetentHold | null,
  now = 0,
): { value: number; hold: DetentHold | null } {
  const dir: -1 | 1 = delta > 0 ? 1 : -1;
  const ticks = Math.abs(delta);
  const detents = binding.detents ?? [];
  if (!detents.length) return { value: clampKnob(current + delta * binding.step, binding), hold: null };
  const here = nearestDetent(current, detents, binding.step);
  if (here !== null) {
    const rested = hold?.path === binding.path && now - hold.since > DETENT_REST_MS;
    const left = rested ? 0 : hold?.path === binding.path && hold.dir === dir ? hold.left : DETENT_CLICKS;
    if (ticks <= left) return { value: here, hold: { path: binding.path, dir, left: left - ticks, since: now } };
    const dest = clampKnob(here + dir * (ticks - left) * binding.step, binding);
    const caught = firstDetent(here, dest, detents);
    if (caught !== null) return { value: caught, hold: { path: binding.path, dir, left: DETENT_CLICKS, since: now } };
    return { value: dest, hold: null };
  }
  const target = clampKnob(current + delta * binding.step, binding);
  const caught = firstDetent(current, target, detents);
  if (caught !== null) return { value: caught, hold: { path: binding.path, dir, left: DETENT_CLICKS, since: now } };
  return { value: target, hold: null };
}

function clampKnob(raw: number, binding: Binding): number {
  let value = raw;
  if (value < binding.min) value = binding.min;
  if (value > binding.max) value = binding.max;
  if (binding.integer) value = Math.round(value);
  return value;
}

function nearestDetent(value: number, detents: readonly number[], step: number): number | null {
  const slack = Math.max(step * 0.5, 1e-9);
  let best: number | null = null;
  let bestDist = slack;
  for (const detent of detents) {
    const dist = Math.abs(value - detent);
    if (dist <= bestDist) {
      best = detent;
      bestDist = dist;
    }
  }
  return best;
}

/** First detent strictly after `from` and not past `to`. */
function firstDetent(from: number, to: number, detents: readonly number[]): number | null {
  if (to === from) return null;
  const dir = to > from ? 1 : -1;
  const eps = 1e-9;
  let best: number | null = null;
  for (const detent of detents) {
    const pastFrom = dir > 0 ? detent > from + eps : detent < from - eps;
    const reached = dir > 0 ? detent <= to + eps : detent >= to - eps;
    if (!pastFrom || !reached) continue;
    if (best === null || (dir > 0 ? detent < best : detent > best)) best = detent;
  }
  return best;
}

/** Put the knob on 0, or on the nearest edge when 0 is outside its range. */
export function resetControl(project: Project, context: ContextId, binding: Binding): Project {
  return storeControl(project, context, binding, 0);
}

function storeControl(project: Project, context: ContextId, binding: Binding, raw: number): Project {
  const value = clampKnob(raw, binding);
  switch (binding.store) {
    case "lane":
      return punch(project, `${context}.${binding.path}`, value);
    case "macro":
      return setMacro(project, binding.path.slice("macro.".length), value);
    case "progression":
      return writeProgression(project, binding.path, value);
    case "mixer":
      return setMixer(project, binding.path as LaneId | "master", value);
    case "global":
      return writeGlobal(project, binding.path, value);
    case "bus":
      return setBus(project, binding.path.slice("bus.".length) as keyof Bus, value);
    case "deck":
      return setDeck(project, binding.path.slice("deck.".length) as keyof Project["deck"], value);
  }
}

function readStored(project: Project, binding: Binding): number {
  switch (binding.store) {
    case "macro":
      return project.macros[binding.path.slice("macro.".length)] ?? 0;
    case "progression":
      return project.progression[binding.path as keyof Progression];
    case "mixer":
      return project.mixer[binding.path as LaneId | "master"];
    case "global":
      if (binding.path === "scale") return SCALE_IDS.indexOf(project.global.scale);
      return project.global[binding.path as keyof typeof project.global] as number;
    case "bus":
      return project.bus[binding.path.slice("bus.".length) as keyof Bus];
    case "deck":
      const key = binding.path.slice("deck.".length);
      const value = project.deck[key as keyof Project["deck"]];
      return typeof value === "number" ? value : 0;
    case "lane":
      return 0;
  }
}

function writeGlobal(project: Project, path: string, value: number): Project {
  const next = clone(project);
  if (path === "scale") next.global.scale = SCALE_IDS[value] ?? SCALE_IDS[0];
  else (next.global as unknown as Record<string, number>)[path] = value;
  return next;
}

function writeProgression(project: Project, path: string, value: number): Project {
  const next = clone(project);
  next.progression[path as keyof Progression] = value;
  return next;
}

function readWorking(project: Project, path: string): number {
  const parts = path.split(".");
  let current: unknown = project.working;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return 0;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" ? current : 0;
}
