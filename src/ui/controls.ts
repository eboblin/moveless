import { clone } from "../core/clone.ts";
import { punch, writeSpace } from "../core/morph.ts";
import { setMacro, setMixer } from "../core/performance.ts";
import { LANES, SCALE_IDS, PROGRESSION_KEYS, type ContextId, type LaneId, type Progression, type Project } from "../core/types.ts";
import type { Binding } from "../core/pages.ts";

const MIXER_PATHS = new Set<string>([...LANES, "master"]);

function readAux(project: Project, path: string): number {
  if (path.startsWith("macro.")) return project.macros[path.slice(6)] ?? 0;
  if (path.startsWith("reverb.") || path.startsWith("delay.")) return readSpace(project, path);
  if ((PROGRESSION_KEYS as readonly string[]).includes(path)) return readProgression(project, path);
  if (MIXER_PATHS.has(path)) return project.mixer[path as LaneId | "master"];
  if (path === "scale") return SCALE_IDS.indexOf(project.global.scale);
  return project.global[path as keyof typeof project.global] as number;
}

function writeAux(project: Project, path: string, value: number): Project {
  if (path.startsWith("macro.")) return setMacro(project, path.slice(6), value);
  if (path.startsWith("reverb.") || path.startsWith("delay.")) return writeSpace(project, path, value);
  if ((PROGRESSION_KEYS as readonly string[]).includes(path)) return writeProgression(project, path, value);
  if (MIXER_PATHS.has(path)) return setMixer(project, path as LaneId | "master", value);
  if (path === "scale") {
    const next = clone(project);
    next.global.scale = SCALE_IDS[value] ?? SCALE_IDS[0];
    return next;
  }
  const next = clone(project);
  (next.global as unknown as Record<string, number>)[path] = value;
  return next;
}

export function readControl(project: Project, context: ContextId, path: string): number {
  if (context === "aux") return readAux(project, path);
  return readWorking(project, `${context}.${path}`);
}

export function writeControl(project: Project, context: ContextId, binding: Binding, delta: number): Project {
  if (delta === 0) return project;
  const current = readControl(project, context, binding.path);
  return storeControl(project, context, binding, current + delta * binding.step);
}

/** Put the knob on 0, or on the nearest edge when 0 is outside its range. */
export function resetControl(project: Project, context: ContextId, binding: Binding): Project {
  return storeControl(project, context, binding, 0);
}

function storeControl(project: Project, context: ContextId, binding: Binding, raw: number): Project {
  let value = raw;
  if (value < binding.min) value = binding.min;
  if (value > binding.max) value = binding.max;
  if (binding.integer) value = Math.round(value);
  if (context === "aux") return writeAux(project, binding.path, value);
  return punch(project, `${context}.${binding.path}`, value);
}

function readProgression(project: Project, path: string): number {
  if (!(PROGRESSION_KEYS as readonly string[]).includes(path)) return 0;
  return project.progression[path as keyof Progression];
}

function writeProgression(project: Project, path: string, value: number): Project {
  if (!(PROGRESSION_KEYS as readonly string[]).includes(path)) return project;
  const next = clone(project);
  next.progression[path as keyof Progression] = value;
  return next;
}

function readSpace(project: Project, path: string): number {
  const [group, key] = path.split(".");
  if (group !== "reverb" && group !== "delay") return 0;
  const box = project.space[group] as unknown as Record<string, number>;
  const value = box[key];
  return typeof value === "number" ? value : 0;
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
