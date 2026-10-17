import { clone } from "../core/clone.ts";
import { punch, writeSpace } from "../core/morph.ts";
import { bindingFor, type Binding } from "../core/pages.ts";
import { setMacro, setMixer } from "../core/performance.ts";
import { SCALE_IDS, type ContextId, type LaneId, type Progression, type Project } from "../core/types.ts";

export function readControl(project: Project, context: ContextId, path: string): number {
  const binding = bindingFor(path);
  if (!binding || binding.store === "lane") return readWorking(project, context === "aux" ? path : `${context}.${path}`);
  return readStored(project, binding);
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
  switch (binding.store) {
    case "lane":
      return punch(project, `${context}.${binding.path}`, value);
    case "macro":
      return setMacro(project, binding.path.slice("macro.".length), value);
    case "space":
      return writeSpace(project, binding.path, value);
    case "progression":
      return writeProgression(project, binding.path, value);
    case "mixer":
      return setMixer(project, binding.path as LaneId | "master", value);
    case "global":
      return writeGlobal(project, binding.path, value);
  }
}

function readStored(project: Project, binding: Binding): number {
  switch (binding.store) {
    case "macro":
      return project.macros[binding.path.slice("macro.".length)] ?? 0;
    case "space":
      return readSpace(project, binding.path);
    case "progression":
      return project.progression[binding.path as keyof Progression];
    case "mixer":
      return project.mixer[binding.path as LaneId | "master"];
    case "global":
      if (binding.path === "scale") return SCALE_IDS.indexOf(project.global.scale);
      return project.global[binding.path as keyof typeof project.global] as number;
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
