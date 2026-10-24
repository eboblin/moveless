import { clone } from "../core/clone.ts";
import { isDeckSlot, readDeckSlot } from "../core/deck.ts";
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
  pending = 0,
): { project: Project; hold: DetentHold | null; pending: number } {
  if (delta === 0) return { project, hold, pending };
  const current = readControl(project, context, binding.path);
  const stepped = stepKnob(current, binding, delta, hold, Date.now(), pending);
  return { project: storeControl(project, context, binding, stepped.value), hold: stepped.hold, pending: stepped.pending };
}

/** Clicks the encoder must spend on a fresh detent before the value moves off it. */
export const DETENT_CLICKS = 8;
/** After this long on a detent, the next turn leaves with no extra clicks. */
export const DETENT_REST_MS = 500;
/** Relative counts in one full turn. 210, the Push figure, swept a dense knob about 1.5× short of 220°. */
export const ENCODER_CLICKS_PER_TURN = 315;
/** Continuous travel of a dense knob, detent holds included. */
export const KNOB_SWEEP_DEG = 220;
/** A sparse knob changes by one step inside this angle, so its whole travel can be shorter. */
export const KNOB_MAX_STEP_DEG = 20;

/**
 * Raw clicks that move this knob by one step.
 * Interior detents spend their hold inside the sweep, so a detented scale does not run long.
 */
export function knobClicksPerStep(binding: Binding): number {
  const increments = binding.step > 0 ? (binding.max - binding.min) / binding.step : 0;
  const interior = (binding.detents ?? []).filter((value) => value > binding.min && value < binding.max).length;
  const degPerClick = 360 / ENCODER_CLICKS_PER_TURN;
  const budget = KNOB_SWEEP_DEG - interior * DETENT_CLICKS * degPerClick;
  let degPerStep = increments > 0 ? budget / increments : KNOB_MAX_STEP_DEG;
  if (!(degPerStep > 0)) degPerStep = 1;
  if (degPerStep > KNOB_MAX_STEP_DEG) degPerStep = KNOB_MAX_STEP_DEG;
  const sensitivity = binding.sensitivity > 0 ? binding.sensitivity : 1;
  return Math.max(((degPerStep / sensitivity) * ENCODER_CLICKS_PER_TURN) / 360, 1e-9);
}

/** One encoder message. Clicks gather toward a step, and a detent catches the crossing. */
export function stepKnob(
  current: number,
  binding: Binding,
  delta: number,
  hold: DetentHold | null,
  now = 0,
  pending = 0,
): { value: number; hold: DetentHold | null; pending: number } {
  if (delta === 0) return { value: current, hold, pending };
  const dir: -1 | 1 = delta > 0 ? 1 : -1;
  let ticks = Math.abs(delta);
  let acc = pending;
  const detents = binding.detents ?? [];
  const here = detents.length ? nearestDetent(current, detents, binding.step) : null;
  if (here !== null) {
    let owed = DETENT_CLICKS;
    if (hold && hold.path === binding.path) {
      if (now - hold.since > DETENT_REST_MS) owed = 0;
      else if (hold.dir === dir) owed = hold.left;
    }
    if (owed > 0) {
      if (acc !== 0 && Math.sign(acc) !== dir) {
        const undo = Math.min(ticks, Math.abs(acc));
        acc -= Math.sign(acc) * undo;
        ticks -= undo;
        if (ticks === 0) {
          const tailDir: -1 | 1 = acc >= 0 ? 1 : -1;
          return { value: here, hold: { path: binding.path, dir: tailDir, left: 0, since: now }, pending: acc };
        }
      }
      if (ticks <= owed) return { value: here, hold: { path: binding.path, dir, left: owed - ticks, since: now }, pending: 0 };
      ticks -= owed;
      acc = 0;
    }
    current = here;
  }
  return walkSteps(current, binding, dir, ticks, acc, now);
}

/** Spend gathered clicks one value step at a time so a detent in between can catch. */
function walkSteps(
  current: number,
  binding: Binding,
  dir: -1 | 1,
  ticks: number,
  pending: number,
  now: number,
): { value: number; hold: DetentHold | null; pending: number } {
  const clicksPerStep = knobClicksPerStep(binding);
  let acc = pending + dir * ticks;
  const detents = binding.detents ?? [];
  let guard = 0;
  while (Math.abs(acc) + 1e-9 >= clicksPerStep && guard++ < 100000) {
    const stepDir: -1 | 1 = acc > 0 ? 1 : -1;
    const next = clampKnob(current + stepDir * binding.step, binding);
    if (Math.abs(next - current) <= 1e-9) return { value: current, hold: null, pending: 0 };
    const caught = firstDetent(current, next, detents);
    if (caught !== null) {
      return { value: caught, hold: { path: binding.path, dir: stepDir, left: DETENT_CLICKS, since: now }, pending: 0 };
    }
    current = next;
    acc -= stepDir * clicksPerStep;
  }
  if (Math.abs(acc) < 1e-9) acc = 0;
  const still = detents.length ? nearestDetent(current, detents, binding.step) : null;
  if (still !== null) {
    const tailDir: -1 | 1 = acc >= 0 ? 1 : -1;
    return { value: still, hold: { path: binding.path, dir: tailDir, left: 0, since: now }, pending: acc };
  }
  return { value: current, hold: null, pending: acc };
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
      return setDeck(project, binding.path.slice("deck.".length), value);
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
      if (!isDeckSlot(key)) return 0;
      return readDeckSlot(project.deck, key);
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
