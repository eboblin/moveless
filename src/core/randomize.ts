import { clone } from "./clone.ts";
import { defaultDeck, focusedGroup, groupIndex, stickDeckFocus } from "./deck.ts";
import { defaultBus, defaultGlobal, defaultProgression, defaultProject } from "./defaults.ts";
import { nodeAt, setPath } from "./fields.ts";
import { hash01 } from "./hash.ts";
import { bindingFor, laneScopePaths } from "./pages.ts";
import {
  LANES,
  SCALE_IDS,
  laneFamily,
  type GlobalSettings,
  type RandomizeDepth,
  type RandomizeIntensity,
  type RandomizeScope,
  type Lanes,
  type PatternId,
  type Project,
} from "./types.ts";

type LaneScope = "pattern" | "notes" | "sound" | "fx" | "all";

export function setRandomizeIntensity(project: Project, intensity: RandomizeIntensity): Project {
  return { ...project, randomizeIntensity: intensity };
}

export function setRandomizeScope(project: Project, scope: RandomizeScope): Project {
  return { ...project, randomizeScope: scope };
}

export function setRandomizeDepth(project: Project, depth: RandomizeDepth): Project {
  return { ...project, randomizeDepth: depth };
}

/** One full-scale step toward home costs `weight`. A step away costs three times that. */
const PAGE_BUDGET: Record<Exclude<RandomizeIntensity, "clear">, number> = {
  soft: 1,
  medium: 2.5,
  hard: 6,
};

/** Largest share of the page budget a single knob may spend. */
const BUDGET_CAP: Record<Exclude<RandomizeIntensity, "clear">, number> = {
  soft: 1,
  medium: 0.5,
  hard: 1 / 3,
};

const AWAY_COST = 3;
const TOWARD_CHANCE = 0.75;

function isGeneratorPath(path: string): boolean {
  return path.endsWith(".pattern") || path.endsWith(".cycle") || path.endsWith(".amount");
}

function depthAllows(path: string, depth: RandomizeDepth): boolean {
  const shape = isGeneratorPath(path);
  if (depth === "generators") return shape;
  if (depth === "values") return !shape;
  return true;
}

/** True when this depth will move the knob. Plain values are not generators. */
export function depthTouchesPath(path: string, depth: RandomizeDepth): boolean {
  return depthAllows(path, depth);
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
  // Pattern below zero names a voice. A roll stays in motif ids.
  const min = path.endsWith(".pattern") ? Math.max(0, binding.min) : binding.min;
  return { min, max: binding.max, step: binding.step, integer: binding.integer, weight: binding.weight };
}

function scopePages(lane: PatternId, scope: LaneScope): string[][] {
  return laneScopePaths(lane, scope);
}

let factoryLanes: Lanes | null = null;

function factoryLane(lane: PatternId): Lanes[PatternId] {
  factoryLanes ??= defaultProject().working;
  return factoryLanes[lane];
}
function spendPage(project: Project, lane: PatternId, paths: string[], tag: string): Project {
  const depth = project.randomizeDepth;
  const intensity = project.randomizeIntensity;
  if (intensity === "clear") return project;
  const eligible = paths.filter((path) => depthAllows(path, depth) && knobSpec(path));
  if (!eligible.length) return project;
  const nonce = project.randomizeNonce + 1;
  const working = clone(project.working);
  const roll = (...parts: (string | number)[]) =>
    hash01(project.global.seed, "capture", nonce, lane, tag, intensity, depth, ...parts);
  applySplitBudget(working[lane], factoryLane(lane), eligible, roll, intensity);
  return { ...project, working, randomizeNonce: nonce };
}

/** Generators and values each receive the full page budget. They do not compete. */
function applySplitBudget(
  root: unknown,
  homes: unknown,
  paths: string[],
  roll: (...parts: (string | number)[]) => number,
  intensity: Exclude<RandomizeIntensity, "clear">,
): void {
  const budget = PAGE_BUDGET[intensity];
  const cap = BUDGET_CAP[intensity];
  const generators = paths.filter(isGeneratorPath);
  const values = paths.filter((path) => !isGeneratorPath(path));
  if (generators.length) applyBudget(root, homes, generators, roll, budget, cap);
  if (values.length) applyBudget(root, homes, values, roll, budget, cap);
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
    let current = readNumber(root, path);
    let home = readNumber(homes, path);
    if (!spec || current === null || home === null) continue;
    const span = spec.max - spec.min;
    if (span <= 0) continue;
    // A stored voice id is outside the roll. Start from the motif floor.
    if (current < spec.min) {
      current = spec.min;
      setPath(root, path, current);
    }
    if (home < spec.min) home = spec.min;
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
    const quantum = spec.step / span;
    let stepUnits = affordable * roll("frac", path);
    // One click or less must be taken whole. A random fraction of that click is
    // always shorter than a step, so the knob would sit there forever.
    if (room <= quantum + 1e-12) {
      if (affordable + 1e-12 < room) continue;
      stepUnits = room;
    } else if (stepUnits + 1e-12 < quantum) continue;
    const sign = targetUnit >= unit ? 1 : -1;
    const target = spec.min + targetUnit * span;
    let next = current + sign * stepUnits * span;
    if (spec.integer) next = Math.round(next);
    else next = spec.min + Math.round((next - spec.min) / spec.step) * spec.step;
    if (sign > 0 && next > target) next = target;
    if (sign < 0 && next < target) next = target;
    if (next < spec.min) next = spec.min;
    if (next > spec.max) next = spec.max;
    if (Math.abs(next - current) + 1e-12 < spec.step) {
      if (room + 1e-12 < quantum) next = Math.min(spec.max, Math.max(spec.min, target));
      else continue;
    }
    const traveled = Math.abs(next - current) / span;
    if (traveled <= 1e-12) continue;
    setPath(root, path, next);
    left -= traveled * costPerUnit;
  }
}

function readNumber(root: unknown, path: string): number | null {
  const value = nodeAt(root, path);
  return typeof value === "number" ? value : null;
}

/** Reroll one page group, or the whole lane when scope is `all`. Each page spends its own budget. */
export function randomizeLane(project: Project, lane: PatternId, scope: LaneScope = "pattern"): Project {
  if (project.lock[lane]) return project;
  if (scope === "notes" && lane !== "fx" && laneFamily(lane) === "drum") return project;
  if (project.randomizeIntensity === "clear") return clearLane(project, lane, scope);
  let next = project;
  scopePages(lane, scope).forEach((paths, index) => {
    next = spendPage(next, lane, paths, `${scope}:${index}`);
  });
  return next;
}

function clearLane(project: Project, lane: PatternId, scope: LaneScope): Project {
  const working = clone(project.working);
  const home = factoryLane(lane);
  for (const paths of scopePages(lane, scope)) restoreFactory(working[lane], home, paths, project.randomizeDepth);
  return { ...project, working, randomizeNonce: project.randomizeNonce + 1 };
}

/** Write factory numbers for the paths this depth is allowed to touch. */
function restoreFactory(root: unknown, homes: unknown, paths: string[], depth: RandomizeDepth): void {
  for (const path of paths) {
    if (!depthAllows(path, depth)) continue;
    const home = readNumber(homes, path);
    if (home === null) continue;
    setPath(root, path, home);
  }
}

/** Knob index for the scale name. Factory minor is 0. */
function globalRecord(global: GlobalSettings): Record<string, number> {
  return {
    tempo: global.tempo,
    swing: global.swing,
    root: global.root,
    scale: Math.max(0, SCALE_IDS.indexOf(global.scale)),
    transpose: global.transpose,
    bar: global.bar,
    phrase: global.phrase,
    seed: global.seed,
  };
}

function globalFromRecord(record: Record<string, number>): GlobalSettings {
  return {
    tempo: record.tempo,
    swing: record.swing,
    root: record.root,
    scale: SCALE_IDS[record.scale] ?? "minor",
    transpose: record.transpose,
    bar: record.bar,
    phrase: record.phrase,
    seed: record.seed,
  };
}

/**
 * Reroll one surface page. Mixer homes are 1. Macro and bus homes are 0.
 * Progression and global homes are the factory project. Each call spends one page budget.
 */
export function randomizeSurface(project: Project, kind: "mix" | "perf" | "progression" | "global" | "bus" | "deck", paths: string[]): Project {
  const depth = project.randomizeDepth;
  const eligible = [...new Set(paths)].filter((path) => depthAllows(path, depth) && knobSpec(path));
  if (!eligible.length) return project;
  const intensity = project.randomizeIntensity;
  const nonce = project.randomizeNonce + 1;
  const roll = (...parts: (string | number)[]) =>
    hash01(project.global.seed, "capture", nonce, kind, intensity, depth, ...parts);
  if (kind === "mix") {
    const mixer = { ...project.mixer };
    const homes: Record<string, number> = {};
    for (const id of [...LANES, "master"] as const) homes[id] = 1;
    if (intensity === "clear") restoreFactory(mixer, homes, eligible, "all");
    else applySplitBudget(mixer, homes, eligible, roll, intensity);
    return { ...project, mixer, randomizeNonce: nonce };
  }
  if (kind === "progression") {
    const progression = { ...project.progression };
    const homes = defaultProgression();
    if (intensity === "clear") restoreFactory(progression, homes, eligible, "all");
    else applySplitBudget(progression, homes, eligible, roll, intensity);
    return { ...project, progression, randomizeNonce: nonce };
  }
  if (kind === "global") {
    const numbers = globalRecord(project.global);
    const homes = globalRecord(defaultGlobal());
    if (intensity === "clear") restoreFactory(numbers, homes, eligible, "all");
    else applySplitBudget(numbers, homes, eligible, roll, intensity);
    return { ...project, global: globalFromRecord(numbers), randomizeNonce: nonce };
  }
  if (kind === "deck") {
    const group = focusedGroup(project.deck);
    const at = groupIndex(group);
    const cell = project.deck.cells[at] ?? { x: 0, y: 0 };
    const homeCell = defaultDeck().cells[at] ?? { x: 0, y: 0 };
    const deck = {
      ...defaultDeck(),
      ...project.deck,
      cells: project.deck.cells.map((item) => ({ ...item })),
      row: cell.y,
      rate: cell.x,
      open: cell.x,
    };
    const homes = { deck: { ...defaultDeck(), row: homeCell.y, rate: homeCell.x, open: homeCell.x } };
    if (intensity === "clear") restoreFactory({ deck }, homes, eligible, "all");
    else applySplitBudget({ deck }, homes, eligible, roll, intensity);
    const cells = deck.cells.map((item) => ({ ...item }));
    const written = { ...(cells[at] ?? { x: 0, y: 0 }) };
    written.y = Math.max(0, Math.min(3, Math.round(deck.row)));
    if (group === "pch") written.x = Math.max(0, Math.min(5, Math.round(deck.rate)));
    if (group === "thr") written.x = Math.max(0, Math.min(5, Math.round(deck.open)));
    cells[at] = written;
    const next = stickDeckFocus(
      {
        div: deck.div,
        len: deck.len,
        depth: deck.depth,
        brake: deck.brake,
        vary: deck.vary,
        quant: deck.quant,
        duty: deck.duty,
        ramp: deck.ramp,
        cells,
        focus: deck.focus,
      },
      project.global.bar,
    );
    return { ...project, deck: next, randomizeNonce: nonce };
  }
  if (kind === "bus") {
    const bus = { ...defaultBus(), ...project.bus };
    const homes = { bus: defaultBus() };
    if (intensity === "clear") restoreFactory({ bus }, homes, eligible, "all");
    else applySplitBudget({ bus }, homes, eligible, roll, intensity);
    return { ...project, bus, randomizeNonce: nonce };
  }
  const macros = { ...project.macros };
  const homes = { macro: {} as Record<string, number> };
  for (const path of eligible) {
    const key = path.slice("macro.".length);
    if (!(key in macros)) macros[key] = 0;
    homes.macro[key] = 0;
  }
  if (intensity === "clear") restoreFactory({ macro: macros }, homes, eligible, "all");
  else applySplitBudget({ macro: macros }, homes, eligible, roll, intensity);
  return { ...project, macros, randomizeNonce: nonce };
}

/** Reroll only the parameters listed on one page. Non-clear spends a generators budget and a values budget. Clear restores those targets. */
export function randomizePaths(project: Project, lane: PatternId, paths: string[]): Project {
  if (project.lock[lane]) return project;
  if (!paths.length) return project;
  if (project.randomizeIntensity !== "clear") return spendPage(project, lane, paths, paths.join(","));
  const working = clone(project.working);
  restoreFactory(working[lane], factoryLane(lane), paths, project.randomizeDepth);
  return { ...project, working, randomizeNonce: project.randomizeNonce + 1 };
}
