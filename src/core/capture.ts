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

function movesValues(depth: CaptureDepth): boolean {
  return depth !== "generators";
}

function movesShape(depth: CaptureDepth): boolean {
  return depth !== "values";
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
      const lowRoom = unit;
      const highRoom = 1 - unit;
      if (atHome) {
        if (lowRoom <= 1e-9) targetUnit = 1;
        else if (highRoom <= 1e-9) targetUnit = 0;
        else targetUnit = roll("side", path) < 0.5 ? 0 : 1;
      } else {
        targetUnit = unit < homeUnit ? 0 : 1;
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
  const intensity = project.captureIntensity;
  const depth = project.captureDepth;
  const nonce = project.captureNonce + 1;
  const working = clone(project.working);
  const roll = (...parts: (string | number)[]) =>
    hash01(project.global.seed, "capture", nonce, lane, scope, intensity, depth, ...parts);
  if (scope === "all") {
    randomizePattern(working, lane, roll, intensity, depth);
    if (lane === "bass" || lane === "lead" || lane === "chords") randomizeNotes(working, lane, roll, intensity, depth);
    randomizeSound(working[lane].sound, intensity, depth);
    randomizeFilter(working[lane].filter, intensity, depth);
    randomizeSend(working[lane].send, intensity, depth);
  } else if (scope === "sound") randomizeSound(working[lane].sound, intensity, depth);
  else if (scope === "fx") {
    randomizeFilter(working[lane].filter, intensity, depth);
    randomizeSend(working[lane].send, intensity, depth);
  }
  else if (scope === "notes") randomizeNotes(working, lane, roll, intensity, depth);
  else randomizePattern(working, lane, roll, intensity, depth);
  return { ...project, working, captureNonce: nonce };
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
      for (const path of eligible) mixer[path as LaneId | "master"] = 0;
      return { ...project, mixer, captureNonce: nonce };
    }
    const macros = { ...project.macros };
    for (const path of eligible) macros[path.slice("macro.".length)] = 0;
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
  if (project.captureIntensity !== "clear") return spendPage(project, lane, generatorFields(target, lane), target);
  const intensity = project.captureIntensity;
  const depth = project.captureDepth;
  const working = clone(project.working);
  const live = nodeAt(working[lane], target);
  const nonce = project.captureNonce + 1;
  if (isEuclidGen(live)) Object.assign(live, touchEuclid(live, intensity, depth));
  else if (isModulated(live)) Object.assign(live, touchModulated(live, intensity, depth));
  return { ...project, working, captureNonce: nonce };
}

/** Reroll only the parameters listed on one page. Non-clear spends one page budget. Clear zeros those targets. */
export function capturePaths(project: Project, lane: LaneId, paths: string[]): Project {
  if (project.lock[lane]) return project;
  if (!paths.length) return project;
  if (project.captureIntensity !== "clear") return spendPage(project, lane, paths, paths.join(","));
  const intensity = project.captureIntensity;
  const depth = project.captureDepth;
  const working = clone(project.working);
  const nonce = project.captureNonce + 1;
  const roll = (...parts: (string | number)[]) =>
    hash01(project.global.seed, "capture", nonce, lane, "page", intensity, depth, ...parts);
  const root = working[lane] as unknown as Record<string, unknown>;
  const seen = new Set<string>();
  for (const path of paths) {
    const target = captureTarget(path);
    if (!target || seen.has(target.key)) continue;
    seen.add(target.key);
    applyCaptureTarget(root, target, roll, intensity, depth);
  }
  return { ...project, working, captureNonce: nonce };
}

type CaptureTarget =
  | { kind: "euclid"; key: string; path: string }
  | { kind: "modulated"; key: string; path: string }
  | { kind: "scalar"; key: string; path: string };

function captureTarget(path: string): CaptureTarget | null {
  const euclid = /^(gen[12])\.(length|hits|rotate|probability|velocity(?:\.(?:value|pattern|cycle|amount))?)$/.exec(path);
  if (euclid) return { kind: "euclid", key: euclid[1], path: euclid[1] };
  const suffixes = [".value", ".pattern", ".cycle", ".amount"];
  const suffix = suffixes.find((item) => path.endsWith(item));
  if (suffix) {
    const base = path.slice(0, -suffix.length);
    return { kind: "modulated", key: base, path: base };
  }
  if (!path.includes(".")) return { kind: "scalar", key: path, path };
  return null;
}

function applyCaptureTarget(
  root: Record<string, unknown>,
  target: CaptureTarget,
  roll: (...parts: (string | number)[]) => number,
  intensity: CaptureIntensity,
  depth: CaptureDepth,
): void {
  if (target.kind === "euclid") {
    const node = nodeAt(root, target.path);
    if (isEuclidGen(node)) Object.assign(node, touchEuclid(node, intensity, depth));
    return;
  }
  if (target.kind === "modulated") {
    const node = nodeAt(root, target.path);
    if (isModulated(node)) Object.assign(node, touchModulated(node, intensity, depth));
    return;
  }
  if (!movesValues(depth)) return;
  if (typeof root[target.path] !== "number") return;
  if (intensity === "clear") {
    root[target.path] = 0;
    return;
  }
  const unit = roll(target.path);
  root[target.path] = unit;
}

function isEuclidGen(value: unknown): value is EuclidGen {
  return !!value && typeof value === "object" && "hits" in value && "length" in value && "rotate" in value && "probability" in value && "velocity" in value;
}

function isModulated(value: unknown): value is Modulated {
  return !!value && typeof value === "object" && "amount" in value && "pattern" in value && "cycle" in value && "value" in value;
}

function touchModulated(current: Modulated, intensity: CaptureIntensity, depth: CaptureDepth): Modulated {
  if (intensity === "clear") return clearedModulated(current, depth);
  return current;
}

function clearedModulated(current: Modulated, depth: CaptureDepth): Modulated {
  const shape = movesShape(depth);
  return {
    value: movesValues(depth) ? 0 : current.value,
    pattern: shape ? 0 : current.pattern,
    cycle: shape ? 0 : current.cycle,
    amount: shape ? 0 : current.amount,
  };
}

function touchEuclid(current: EuclidGen, intensity: CaptureIntensity, depth: CaptureDepth): EuclidGen {
  const values = movesValues(depth);
  if (intensity !== "clear") return current;
  return {
    length: values ? 0 : current.length,
    hits: values ? 0 : current.hits,
    rotate: values ? 0 : current.rotate,
    probability: values ? 0 : current.probability,
    velocity: clearedModulated(current.velocity, depth),
  };
}

function randomizePattern(
  lanes: Lanes,
  lane: LaneId,
  roll: (...parts: (string | number)[]) => number,
  intensity: CaptureIntensity,
  depth: CaptureDepth,
): void {
  if (lane === "chords") {
    const chords = lanes.chords;
    chords.rate = touchModulated(chords.rate, intensity, depth);
    chords.gate = touchModulated(chords.gate, intensity, depth);
    return;
  }
  const target = lanes[lane];
  target.gen1 = touchEuclid(target.gen1, intensity, depth);
  target.gen2 = touchEuclid(target.gen2, intensity, depth);
  if (lane === "bass" || lane === "lead") {
    const pitched = lanes[lane];
    pitched.repeat = touchModulated(pitched.repeat, intensity, depth);
    pitched.step = touchModulated(pitched.step, intensity, depth);
    if (movesValues(depth)) pitched.follow = intensity === "clear" ? 0 : roll("follow");
    return;
  }
  const drum = lanes[lane];
  drum.ratchet.count = touchModulated(drum.ratchet.count, intensity, depth);
  drum.ratchet.rate = touchModulated(drum.ratchet.rate, intensity, depth);
}

function randomizeNotes(
  lanes: Lanes,
  lane: LaneId,
  roll: (...parts: (string | number)[]) => number,
  intensity: CaptureIntensity,
  depth: CaptureDepth,
): void {
  if (lane === "bass" || lane === "lead") {
    const pitched = lanes[lane];
    pitched.pitch = touchModulated(pitched.pitch, intensity, depth);
    pitched.octave = touchModulated(pitched.octave, intensity, depth);
    pitched.length = touchModulated(pitched.length, intensity, depth);
    if (movesValues(depth)) pitched.follow = intensity === "clear" ? 0 : roll("follow");
    return;
  }
  if (lane !== "chords") return;
  const chords = lanes.chords;
  chords.tone = touchModulated(chords.tone, intensity, depth);
  chords.octave = touchModulated(chords.octave, intensity, depth);
  chords.velocity = touchModulated(chords.velocity, intensity, depth);
}

function randomizeSound(sound: Record<string, Modulated>, intensity: CaptureIntensity, depth: CaptureDepth): void {
  for (const id of Object.keys(sound)) sound[id] = touchModulated(sound[id], intensity, depth);
}

function randomizeFilter(filter: { cutoff: Modulated; resonance: Modulated }, intensity: CaptureIntensity, depth: CaptureDepth): void {
  filter.cutoff = touchModulated(filter.cutoff, intensity, depth);
  filter.resonance = touchModulated(filter.resonance, intensity, depth);
}

function randomizeSend(send: { reverb: Modulated; delay: Modulated }, intensity: CaptureIntensity, depth: CaptureDepth): void {
  send.reverb = touchModulated(send.reverb, intensity, depth);
  send.delay = touchModulated(send.delay, intensity, depth);
}
