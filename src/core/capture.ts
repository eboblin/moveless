import { clone } from "./clone.ts";
import { defaultProject } from "./defaults.ts";
import { nodeAt, setPath } from "./fields.ts";
import { hash01 } from "./hash.ts";
import { bindingFor, laneScopePaths, modulatorPaths } from "./pages.ts";
import {
  LANES,
  laneFamily,
  type CaptureDepth,
  type CaptureIntensity,
  type CaptureScope,
  type EuclidGen,
  type LaneId,
  type Lanes,
  type Modulated,
  type Project,
} from "./types.ts";

type LaneCapture = "pattern" | "notes" | "sound" | "fx" | "all";

export function setCaptureIntensity(project: Project, intensity: CaptureIntensity): Project {
  return { ...project, captureIntensity: intensity };
}

export function setCaptureScope(project: Project, scope: CaptureScope): Project {
  return { ...project, captureScope: scope };
}

export function setCaptureDepth(project: Project, depth: CaptureDepth): Project {
  return { ...project, captureDepth: depth };
}

/** One full-scale step toward home costs `weight`. A step away costs three times that. */
const PAGE_BUDGET: Record<Exclude<CaptureIntensity, "clear">, number> = {
  soft: 1,
  medium: 2.5,
  hard: 6,
};

/** Largest share of the page budget a single knob may spend. */
const BUDGET_CAP: Record<Exclude<CaptureIntensity, "clear">, number> = {
  soft: 1,
  medium: 0.5,
  hard: 1 / 3,
};

const AWAY_COST = 3;
const TOWARD_CHANCE = 0.75;

function depthAllows(path: string, depth: CaptureDepth): boolean {
  const shape = path.endsWith(".pattern") || path.endsWith(".cycle") || path.endsWith(".amount");
  if (depth === "generators") return shape;
  if (depth === "values") return !shape;
  return true;
}

interface KnobSpec {
  min: number;
  max: number;
  step: number;
  integer: boolean;
  weight: number;
}

function knobSpec(path: string): KnobSpec | null {
  const binding = bindingFor(path);
  if (!binding) return null;
  return { min: binding.min, max: binding.max, step: binding.step, integer: binding.integer, weight: binding.weight };
}

function scopePages(lane: LaneId, scope: LaneCapture): string[][] {
  return laneScopePaths(lane, scope);
}

function generatorFields(target: string, lane: LaneId): string[] {
  return modulatorPaths(lane, target);
}

let factoryLanes: Lanes | null = null;

function factoryLane(lane: LaneId): Lanes[LaneId] {
  factoryLanes ??= defaultProject().working;
  return factoryLanes[lane];
}
function spendPage(project: Project, lane: LaneId, paths: string[], tag: string): Project {
  const depth = project.captureDepth;
  const intensity = project.captureIntensity;
  if (intensity === "clear") return project;
  const eligible = paths.filter((path) => depthAllows(path, depth) && knobSpec(path));
  if (!eligible.length) return project;
  const nonce = project.captureNonce + 1;
  const working = clone(project.working);
  const roll = (...parts: (string | number)[]) =>
    hash01(project.global.seed, "capture", nonce, lane, tag, intensity, depth, ...parts);
  applyBudget(working[lane], factoryLane(lane), eligible, roll, PAGE_BUDGET[intensity], BUDGET_CAP[intensity]);
  return { ...project, working, captureNonce: nonce };
}

function applyBudget(
  root: unknown,
  homes: unknown,
  paths: string[],
  roll: (...parts: (string | number)[]) => number,
  budget: number,
  capFraction: number,
): void {
  const ordered = paths
    .map((path) => ({ path, rank: roll("ord", path) }))
    .sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : 1));
  let left = budget;
  const cap = budget * capFraction;
  for (const { path } of ordered) {
    if (left <= 1e-9) break;
    const spec = knobSpec(path);
    const current = readNumber(root, path);
    const home = readNumber(homes, path);
    if (!spec || current === null || home === null) continue;
    const span = spec.max - spec.min;
    if (span <= 0) continue;
    const unit = (current - spec.min) / span;
    const homeUnit = (home - spec.min) / span;
    const towardRoom = Math.abs(unit - homeUnit);
    const atHome = towardRoom <= 1e-9;
    const wantToward = !atHome && roll("dir", path) < TOWARD_CHANCE;
    let targetUnit = homeUnit;
    if (!wantToward) {
      if (atHome) {
        const lowRoom = unit;
        const highRoom = 1 - unit;
        if (lowRoom <= 1e-9) targetUnit = 1;
        else if (highRoom <= 1e-9) targetUnit = 0;
        else targetUnit = roll("side", path) < 0.5 ? 0 : 1;
      } else {
        const mirrored = unit + (unit - homeUnit);
        targetUnit = mirrored < 0 ? 0 : mirrored > 1 ? 1 : mirrored;
      }
    }
    const room = Math.abs(targetUnit - unit);
    if (room <= 1e-9) continue;
    const costPerUnit = spec.weight * (wantToward ? 1 : AWAY_COST);
    const affordable = Math.min(room, left / costPerUnit, cap / costPerUnit);
    const stepUnits = affordable * roll("frac", path);
    if (stepUnits * span + 1e-12 < spec.step) continue;
    const sign = targetUnit >= unit ? 1 : -1;
    let next = current + sign * stepUnits * span;
    if (spec.integer) next = Math.round(next);
    if (next < spec.min) next = spec.min;
    if (next > spec.max) next = spec.max;
    const traveled = Math.abs(next - current) / span;
    if (traveled * span + 1e-12 < spec.step) continue;
    setPath(root, path, next);
    left -= traveled * costPerUnit;
  }
}

function readNumber(root: unknown, path: string): number | null {
  const value = nodeAt(root, path);
  return typeof value === "number" ? value : null;
}

/** Reroll one page group, or the whole lane when scope is `all`. Each page spends its own budget. */
export function captureLane(project: Project, lane: LaneId, scope: LaneCapture = "pattern"): Project {
  if (project.lock[lane]) return project;
  if (scope === "notes" && laneFamily(lane) === "drum") return project;
  if (project.captureIntensity === "clear") return clearLane(project, lane, scope);
  let next = project;
  scopePages(lane, scope).forEach((paths, index) => {
    next = spendPage(next, lane, paths, `${scope}:${index}`);
  });
  return next;
}

function clearLane(project: Project, lane: LaneId, scope: LaneCapture): Project {
  const working = clone(project.working);
  const home = factoryLane(lane);
  for (const paths of scopePages(lane, scope)) restoreFactory(working[lane], home, paths, project.captureDepth);
  return { ...project, working, captureNonce: project.captureNonce + 1 };
}

/** Write factory numbers for the paths this depth is allowed to touch. */
function restoreFactory(root: unknown, homes: unknown, paths: string[], depth: CaptureDepth): void {
  for (const path of paths) {
    if (!depthAllows(path, depth)) continue;
    const home = readNumber(homes, path);
    if (home === null) continue;
    setPath(root, path, home);
  }
}

/** Reroll mixer faders or perf macros. Homes: mixer channel 1 (shown as 100), macro 0. */
export function captureSurface(project: Project, kind: "mix" | "perf", paths: string[]): Project {
  const depth = project.captureDepth;
  const eligible = [...new Set(paths)].filter((path) => depthAllows(path, depth) && knobSpec(path));
  if (!eligible.length) return project;
  const intensity = project.captureIntensity;
  const nonce = project.captureNonce + 1;
  if (intensity === "clear") {
    if (kind === "mix") {
      const mixer = { ...project.mixer };
      const homes: Record<string, number> = {};
      for (const id of [...LANES, "master"] as const) homes[id] = 1;
      restoreFactory(mixer, homes, eligible, "all");
      return { ...project, mixer, captureNonce: nonce };
    }
    const macros = { ...project.macros };
    const homes = { macro: {} as Record<string, number> };
    for (const path of eligible) homes.macro[path.slice("macro.".length)] = 0;
    restoreFactory({ macro: macros }, homes, eligible, "all");
    return { ...project, macros, captureNonce: nonce };
  }
  const roll = (...parts: (string | number)[]) =>
    hash01(project.global.seed, "capture", nonce, kind, intensity, depth, ...parts);
  const budget = PAGE_BUDGET[intensity];
  const cap = BUDGET_CAP[intensity];
  if (kind === "mix") {
    const mixer = { ...project.mixer };
    const homes: Record<string, number> = {};
    for (const id of [...LANES, "master"] as const) homes[id] = 1;
    applyBudget(mixer, homes, eligible, roll, budget, cap);
    return { ...project, mixer, captureNonce: nonce };
  }
  const macros = { ...project.macros };
  const homes = { macro: {} as Record<string, number> };
  for (const path of eligible) {
    const key = path.slice("macro.".length);
    if (!(key in macros)) macros[key] = 0;
    homes.macro[key] = 0;
  }
  applyBudget({ macro: macros }, homes, eligible, roll, budget, cap);
  return { ...project, macros, captureNonce: nonce };
}

/** Reroll one euclid (`gen1`), its velocity, or another 4-param modulator. */
export function captureGenerator(project: Project, lane: LaneId, target: string): Project {
  if (project.lock[lane]) return project;
  const node = nodeAt(project.working[lane], target);
  if (!isEuclidGen(node) && !isModulated(node)) return project;
  const paths = generatorFields(target, lane);
  if (project.captureIntensity !== "clear") return spendPage(project, lane, paths, target);
  const working = clone(project.working);
  restoreFactory(working[lane], factoryLane(lane), paths, project.captureDepth);
  return { ...project, working, captureNonce: project.captureNonce + 1 };
}

/** Reroll only the parameters listed on one page. Non-clear spends one page budget. Clear restores those targets. */
export function capturePaths(project: Project, lane: LaneId, paths: string[]): Project {
  if (project.lock[lane]) return project;
  if (!paths.length) return project;
  if (project.captureIntensity !== "clear") return spendPage(project, lane, paths, paths.join(","));
  const working = clone(project.working);
  restoreFactory(working[lane], factoryLane(lane), paths, project.captureDepth);
  return { ...project, working, captureNonce: project.captureNonce + 1 };
}

function isEuclidGen(value: unknown): value is EuclidGen {
  return !!value && typeof value === "object" && "hits" in value && "length" in value && "rotate" in value && "probability" in value && "velocity" in value;
}

function isModulated(value: unknown): value is Modulated {
  return !!value && typeof value === "object" && "amount" in value && "pattern" in value && "cycle" in value && "value" in value;
}
