import { clone } from "../core/clone.ts";
import { punch } from "../core/morph.ts";
import { setMacro, setMixer } from "../core/performance.ts";
import { SCALE_IDS, type ContextId, type LaneId, type Project } from "../core/types.ts";
import type { Binding } from "../core/pages.ts";

export function readControl(project: Project, context: ContextId, path: string): number {
  if (context === "mix") return project.mixer[path as LaneId | "master"];
  if (context === "perf") return project.macros[path.startsWith("macro.") ? path.slice(6) : path] ?? 0;
  if (context === "global") {
    if (path.startsWith("macro.")) return project.macros[path.slice(6)] ?? 0;
    if (path === "scale") return SCALE_IDS.indexOf(project.global.scale);
    return project.global[path as keyof typeof project.global] as number;
  }
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
  if (context === "mix") return setMixer(project, binding.path as LaneId | "master", value);
  if (context === "perf") return setMacro(project, binding.path.startsWith("macro.") ? binding.path.slice(6) : binding.path, value);
  if (context === "global") {
    if (binding.path.startsWith("macro.")) return setMacro(project, binding.path.slice(6), value);
    if (binding.path === "scale") {
      const next = clone(project);
      next.global.scale = SCALE_IDS[value] ?? SCALE_IDS[0];
      return next;
    }
    const next = clone(project);
    (next.global as unknown as Record<string, number>)[binding.path] = value;
    return next;
  }
  return punch(project, `${context}.${binding.path}`, value);
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
