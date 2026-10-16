import { ticksPerBar } from "./clock.ts";
import { clone } from "./clone.ts";
import { defaultProject } from "./defaults.ts";
import { hash01 } from "./hash.ts";
import { applyMorph, retarget } from "./morph.ts";
import {
  CAPTURE_INTENSITIES,
  LANES,
  SET_CAPACITY,
  SOUND,
  WANDER_BARS,
  type CaptureDepth,
  type CaptureIntensity,
  type CaptureScope,
  type EuclidGen,
  type LaneId,
  type Lanes,
  type Modulated,
  type Project,
  type Scene,
  type WanderId,
} from "./types.ts";

export { CAPTURE_INTENSITIES };

/** Bright palette indices 1–26 only — each has dim/dark partners at 63+2c / 64+2c. */
const SCENE_COLORS = [1, 2, 3, 5, 7, 8, 9, 11, 14, 15, 16, 17, 20, 22, 23, 25];

export function sceneColor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return SCENE_COLORS[(hash >>> 0) % SCENE_COLORS.length];
}

export function record(project: Project): Project {
  const id = String(project.nextSceneId).padStart(3, "0");
  const scene: Scene = {
    id,
    lanes: clone(project.working),
    color: sceneColor(id),
  };
  return {
    ...project,
    nextSceneId: project.nextSceneId + 1,
    journal: [...project.journal, scene],
    activeSceneId: id,
  };
}

function emptyPads(): (string | null)[] {
  return Array.from({ length: SET_CAPACITY }, () => null);
}

export function journalPadIds(project: Project): (string | null)[] {
  const slots = emptyPads();
  project.journal.slice(-SET_CAPACITY).forEach((scene, index) => {
    slots[index] = scene.id;
  });
  return slots;
}

export function setPadIds(project: Project): (string | null)[] {
  const slots = emptyPads();
  const active = project.sets.find((set) => set.id === project.activeSetId);
  (active?.sceneIds ?? []).slice(0, SET_CAPACITY).forEach((id, index) => {
    slots[index] = id;
  });
  return slots;
}

/** Wander reads the active set when it has scenes, and the journal otherwise. */
export function sceneIdsForPads(project: Project): (string | null)[] {
  const fromSet = setPadIds(project);
  if (fromSet.some((id) => id !== null)) return fromSet;
  return journalPadIds(project);
}

export function launchScene(project: Project, sceneId: string, tick: number): Project {
  const current = applyMorph(project, tick);
  const scene = current.journal.find((item) => item.id === sceneId);
  if (!scene) return current;
  return retarget(current, scene, tick);
}

export function pickWanderCandidate(ids: readonly string[], previous: string | null, seed: number, salt: number): string | null {
  const present = ids.filter((id): id is string => id !== null);
  if (!present.length) return null;
  const pool = present.filter((id) => id !== previous);
  const use = pool.length ? pool : present;
  const index = Math.min(use.length - 1, Math.floor(hash01(seed, "wander", salt) * use.length));
  return use[index];
}

export function advance(project: Project, tick: number): Project {
  let next = applyMorph(project, tick);
  if (!next.wander) return next;
  const interval = WANDER_BARS[next.wander] * ticksPerBar(next.global.bar);
  let origin = next.wanderOriginTick;
  let guard = 0;
  while (tick - origin >= interval && guard < 8) {
    origin += interval;
    const pick = pickWanderCandidate(sceneIdsForPads(next).filter((id): id is string => id !== null), next.wanderPreviousTarget, next.global.seed, origin);
    const scene = pick ? next.journal.find((item) => item.id === pick) : undefined;
    next = { ...next, wanderOriginTick: origin };
    if (scene) {
      next = retarget(next, scene, origin);
      next = { ...applyMorph(next, tick), wanderPreviousTarget: scene.id, wanderOriginTick: origin };
    }
    guard++;
  }
  return next;
}

export function setWander(project: Project, rate: WanderId | null, tick: number): Project {
  if (rate === null || project.wander === rate) {
    return { ...project, wander: null };
  }
  return { ...project, wander: rate, wanderOriginTick: tick };
}

export function toggleMute(project: Project, lane: LaneId): Project {
  return { ...project, mute: { ...project.mute, [lane]: !project.mute[lane] } };
}

export function toggleLock(project: Project, lane: LaneId): Project {
  return { ...project, lock: { ...project.lock, [lane]: !project.lock[lane] } };
}

export function createSet(project: Project, name: string): Project {
  const set = { id: `set-${project.sets.length + 1}`, name, sceneIds: [] as string[] };
  return { ...project, sets: [...project.sets, set], activeSetId: set.id };
}

export function cycleSet(project: Project, direction: number): Project {
  if (!project.sets.length) return project;
  const index = Math.max(0, project.sets.findIndex((set) => set.id === project.activeSetId));
  const next = (index + direction + project.sets.length) % project.sets.length;
  return { ...project, activeSetId: project.sets[next].id };
}

export function copyScene(project: Project, sceneId: string): Project {
  if (!project.journal.some((scene) => scene.id === sceneId)) return project;
  return { ...project, clipboardSceneId: sceneId };
}

export function pasteClipboard(project: Project): Project {
  if (!project.clipboardSceneId || !project.activeSetId) return project;
  return addSceneToSet(project, project.activeSetId, project.clipboardSceneId);
}

export function addSceneToSet(project: Project, setId: string, sceneId: string): Project {
  if (!project.journal.some((scene) => scene.id === sceneId)) return project;
  return {
    ...project,
    sets: project.sets.map((set) => {
      if (set.id !== setId) return set;
      if (set.sceneIds.includes(sceneId) || set.sceneIds.length >= SET_CAPACITY) return set;
      return { ...set, sceneIds: [...set.sceneIds, sceneId] };
    }),
  };
}

export function removeSceneFromSet(project: Project, setId: string, sceneId: string): Project {
  return {
    ...project,
    sets: project.sets.map((set) => set.id === setId ? { ...set, sceneIds: set.sceneIds.filter((id) => id !== sceneId) } : set),
  };
}

/** Drop a scene from the journal and strip every set reference to it. */
export function removeSceneFromJournal(project: Project, sceneId: string): Project {
  if (!project.journal.some((scene) => scene.id === sceneId)) return project;
  return {
    ...project,
    journal: project.journal.filter((scene) => scene.id !== sceneId),
    sets: project.sets.map((set) => ({
      ...set,
      sceneIds: set.sceneIds.filter((id) => id !== sceneId),
    })),
    clipboardSceneId: project.clipboardSceneId === sceneId ? null : project.clipboardSceneId,
    activeSceneId: project.activeSceneId === sceneId ? null : project.activeSceneId,
    wanderPreviousTarget: project.wanderPreviousTarget === sceneId ? null : project.wanderPreviousTarget,
    morph: project.morph?.targetId === sceneId ? null : project.morph,
  };
}

export function deleteSet(project: Project, setId: string): Project {
  const sets = project.sets.filter((set) => set.id !== setId);
  const activeSetId = project.activeSetId === setId ? (sets[0]?.id ?? null) : project.activeSetId;
  return { ...project, sets, activeSetId };
}

export function setMacro(project: Project, id: string, offset: number): Project {
  return { ...project, macros: { ...project.macros, [id]: offset } };
}

export function setMixer(project: Project, id: LaneId | "master", value: number): Project {
  return { ...project, mixer: { ...project.mixer, [id]: clampMixer(value) } };
}

function clampMixer(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

type LaneCapture = "pattern" | "notes" | "sound" | "all";

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
const HEAVY_SOUND = new Set(["pitch", "cutoff", "tone", "decay", "snap"]);

function depthAllows(path: string, depth: CaptureDepth): boolean {
  const shape = path.endsWith(".pattern") || path.endsWith(".cycle") || path.endsWith(".amount");
  if (depth === "generators") return shape;
  if (depth === "values") return !shape;
  return true;
}

function weightFor(path: string): number {
  if (path === "ratchet.count.value" || path === "repeat.value" || path === "ratchet.rate.value" || path === "rate.value") return 8;
  if (path.endsWith(".pattern")) return 1;
  if (path.endsWith(".amount")) return 1.2;
  if (path.endsWith(".cycle")) return 1.5;
  if (path.endsWith(".rotate")) return 2;
  if (path.endsWith(".probability")) return 3;
  if (path.endsWith(".hits")) return 5;
  if (path.startsWith("gen") && path.endsWith(".length")) return 6;
  if (path === "follow") return 6;
  if (path === "start" || path === "count" || path === "motion" || path === "length") return 6;
  if (path === "mood" || path === "tension" || path === "spread" || path === "flow") return 3;
  if (path === "variation" || path === "way" || path === "direction" || path === "octaves") return 4;
  if (path.endsWith(".value")) {
    const id = path.split(".").at(-2) ?? "";
    return HEAVY_SOUND.has(id) ? 8 : 4;
  }
  return 4;
}

interface KnobSpec {
  min: number;
  max: number;
  step: number;
  integer: boolean;
}

function knobSpec(path: string): KnobSpec | null {
  if (path.endsWith(".value")) return { min: 0, max: 1, step: 0.01, integer: false };
  if (path.endsWith(".pattern")) return { min: 0, max: 63, step: 1, integer: true };
  if (path.endsWith(".cycle")) return { min: 1, max: 64, step: 1, integer: true };
  if (path.endsWith(".amount")) return { min: -1, max: 1, step: 0.01, integer: false };
  if (path.startsWith("gen") && (path.endsWith(".length") || path.endsWith(".hits") || path.endsWith(".rotate"))) {
    return { min: 0, max: 64, step: 1, integer: true };
  }
  if (path.endsWith(".probability")) return { min: 0, max: 1, step: 0.01, integer: false };
  if (path === "follow") return { min: 0, max: 1, step: 0.01, integer: false };
  if (path.startsWith("macro.")) return { min: -1, max: 1, step: 0.01, integer: false };
  if (path === "master" || (LANES as readonly string[]).includes(path)) return { min: 0, max: 1, step: 0.01, integer: false };
  const chord = CHORD_RANGE[path];
  if (!chord) return null;
  const [min, max, integer] = chord;
  return { min, max, step: integer ? 1 : 0.01, integer };
}

function vpcaPaths(base: string): string[] {
  return [`${base}.value`, `${base}.pattern`, `${base}.cycle`, `${base}.amount`];
}

function genPagePaths(which: 1 | 2): string[] {
  const prefix = `gen${which}`;
  return [`${prefix}.length`, `${prefix}.hits`, `${prefix}.rotate`, `${prefix}.probability`, ...vpcaPaths(`${prefix}.velocity`)];
}

function soundPagePaths(lane: LaneId): string[][] {
  const ids = SOUND[lane];
  const pages: string[][] = [];
  for (let i = 0; i < ids.length; i += 2) {
    const paths = vpcaPaths(`sound.${ids[i]}`);
    if (ids[i + 1]) paths.push(...vpcaPaths(`sound.${ids[i + 1]}`));
    pages.push(paths);
  }
  return pages;
}

function patternPages(lane: LaneId): string[][] {
  if (lane === "chords") return [];
  const pages = [genPagePaths(1), genPagePaths(2)];
  if (lane === "bass" || lane === "lead") pages.push([...vpcaPaths("repeat"), ...vpcaPaths("step")]);
  else pages.push([...vpcaPaths("ratchet.count"), ...vpcaPaths("ratchet.rate")]);
  return pages;
}

function notePages(lane: LaneId): string[][] {
  if (lane === "bass" || lane === "lead") {
    return [[...vpcaPaths("pitch"), ...vpcaPaths("octave")], [...vpcaPaths("length"), "follow"]];
  }
  if (lane !== "chords") return [];
  return [
    ["start", "count", "length", "motion", "variation", "mood", "tension", "way"],
    [...vpcaPaths("rate"), ...vpcaPaths("gate")],
    ["spread", "flow", "octaves", "direction"],
  ];
}

function scopePages(lane: LaneId, scope: LaneCapture): string[][] {
  if (scope === "sound") return soundPagePaths(lane);
  if (scope === "notes") return notePages(lane);
  if (scope === "pattern") return patternPages(lane);
  return [...patternPages(lane), ...notePages(lane), ...soundPagePaths(lane)];
}

function generatorFields(target: string): string[] {
  if (target === "gen1" || target === "gen2") return genPagePaths(target === "gen1" ? 1 : 2);
  return vpcaPaths(target);
}

/** Spend one page budget on these knobs. Delete does not come here. */
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
  applyBudget(working[lane], defaultProject().working[lane], eligible, roll, PAGE_BUDGET[intensity], BUDGET_CAP[intensity]);
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
    const costPerUnit = weightFor(path) * (wantToward ? 1 : AWAY_COST);
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
    writeNumber(root, path, next);
    left -= traveled * costPerUnit;
  }
}

function readNumber(root: unknown, path: string): number | null {
  const value = readNode(root, path);
  return typeof value === "number" ? value : null;
}

function writeNumber(root: unknown, path: string, value: number): void {
  const parts = path.split(".");
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[parts[i]];
  }
  if (current === null || typeof current !== "object") return;
  (current as Record<string, unknown>)[parts[parts.length - 1]] = value;
}

/** Reroll one page group, or the whole lane when scope is `all`. Each page spends its own budget. */
export function captureLane(project: Project, lane: LaneId, scope: LaneCapture = "pattern"): Project {
  if (project.lock[lane]) return project;
  if (scope === "notes" && lane !== "bass" && lane !== "lead" && lane !== "chords") return project;
  if (scope === "pattern" && lane === "chords") return project;
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
    if (lane !== "chords") randomizePattern(working, lane, roll, intensity, depth);
    if (lane === "bass" || lane === "lead" || lane === "chords") randomizeNotes(working, lane, roll, intensity, depth);
    randomizeSound(working[lane].sound, roll, intensity, depth);
  } else if (scope === "sound") randomizeSound(working[lane].sound, roll, intensity, depth);
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
  const node = readNode(project.working[lane], target);
  if (!isEuclidGen(node) && !isModulated(node)) return project;
  if (project.captureIntensity !== "clear") return spendPage(project, lane, generatorFields(target), target);
  const intensity = project.captureIntensity;
  const depth = project.captureDepth;
  const working = clone(project.working);
  const live = readNode(working[lane], target);
  const nonce = project.captureNonce + 1;
  const roll = (...parts: (string | number)[]) =>
    hash01(project.global.seed, "capture", nonce, lane, target, intensity, depth, ...parts);
  if (isEuclidGen(live)) Object.assign(live, touchEuclid(live, roll, "", intensity, depth));
  else if (isModulated(live)) Object.assign(live, touchMaybeExpensive(live, roll, target, intensity, isRatchetPath(target), depth));
  return { ...project, working, captureNonce: nonce };
}

/**
 * Reroll only the parameters listed on one page (binding paths). Avoids importing pages.ts.
 * Non-clear spends one page budget across the knobs. Clear still zeros the grouped targets.
 */
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

const CHORD_RANGE: Record<string, [number, number, boolean]> = {
  start: [-7, 7, true],
  count: [1, 16, true],
  length: [0, 4, true],
  motion: [0, 7, true],
  variation: [0, 3, true],
  mood: [0, 1, false],
  tension: [0, 1, false],
  way: [0, 3, true],
  spread: [0, 1, false],
  flow: [0, 1, false],
  octaves: [1, 4, true],
  direction: [0, 7, true],
};

function rollChordScalar(key: string, unit: number): number {
  const spec = CHORD_RANGE[key];
  if (!spec) return unit;
  const [min, max, integer] = spec;
  const value = min + unit * (max - min);
  if (!integer) return value;
  return Math.max(min, Math.min(max, Math.round(value)));
}

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
    const node = readNode(root, target.path);
    if (isEuclidGen(node)) Object.assign(node, touchEuclid(node, roll, target.path, intensity, depth));
    return;
  }
  if (target.kind === "modulated") {
    const node = readNode(root, target.path);
    if (isModulated(node)) {
      Object.assign(node, touchMaybeExpensive(node, roll, target.path, intensity, isRatchetPath(target.path), depth));
    }
    return;
  }
  if (!movesValues(depth)) return;
  if (typeof root[target.path] !== "number") return;
  if (intensity === "clear") {
    root[target.path] = 0;
    return;
  }
  const unit = roll(target.path);
  root[target.path] = target.path in CHORD_RANGE ? rollChordScalar(target.path, unit) : unit;
}

function readNode(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isEuclidGen(value: unknown): value is EuclidGen {
  return !!value && typeof value === "object" && "hits" in value && "length" in value && "rotate" in value && "probability" in value && "velocity" in value;
}

function isModulated(value: unknown): value is Modulated {
  return !!value && typeof value === "object" && "amount" in value && "pattern" in value && "cycle" in value && "value" in value;
}

function isRatchetPath(path: string): boolean {
  return path === "ratchet.count" || path === "ratchet.rate" || path.startsWith("ratchet.");
}

/** Ratchet (and other gated modulators): whole touch is expensive, like euclid structure. */
function touchMaybeExpensive(
  current: Modulated,
  roll: (...parts: (string | number)[]) => number,
  prefix: string,
  intensity: CaptureIntensity,
  _expensiveWhole: boolean,
  depth: CaptureDepth,
): Modulated {
  return touchModulated(current, roll, prefix, intensity, depth);
}

function touchModulated(
  current: Modulated,
  _roll: (...parts: (string | number)[]) => number,
  _prefix: string,
  intensity: CaptureIntensity,
  depth: CaptureDepth,
): Modulated {
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

function touchEuclid(
  current: EuclidGen,
  _roll: (...parts: (string | number)[]) => number,
  _prefix: string,
  intensity: CaptureIntensity,
  depth: CaptureDepth,
): EuclidGen {
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

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function randomizePattern(
  lanes: Lanes,
  lane: LaneId,
  roll: (...parts: (string | number)[]) => number,
  intensity: CaptureIntensity,
  depth: CaptureDepth,
): void {
  if (lane === "chords") return;
  const target = lanes[lane];
  target.gen1 = touchEuclid(target.gen1, roll, "gen1", intensity, depth);
  target.gen2 = touchEuclid(target.gen2, roll, "gen2", intensity, depth);
  if (lane === "bass" || lane === "lead") {
    const pitched = lanes[lane];
    pitched.repeat = touchModulated(pitched.repeat, roll, "repeat", intensity, depth);
    pitched.step = touchModulated(pitched.step, roll, "step", intensity, depth);
    if (movesValues(depth)) pitched.follow = intensity === "clear" ? 0 : roll("follow");
    return;
  }
  const drum = lanes[lane];
  drum.ratchet.count = touchMaybeExpensive(drum.ratchet.count, roll, "ratchet.count", intensity, true, depth);
  drum.ratchet.rate = touchMaybeExpensive(drum.ratchet.rate, roll, "ratchet.rate", intensity, true, depth);
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
    pitched.pitch = touchModulated(pitched.pitch, roll, "pitch", intensity, depth);
    pitched.octave = touchModulated(pitched.octave, roll, "octave", intensity, depth);
    pitched.length = touchModulated(pitched.length, roll, "length", intensity, depth);
    if (movesValues(depth)) pitched.follow = intensity === "clear" ? 0 : roll("follow");
    return;
  }
  if (lane !== "chords") return;
  const chords = lanes.chords;
  chords.rate = touchModulated(chords.rate, roll, "rate", intensity, depth);
  chords.gate = touchModulated(chords.gate, roll, "gate", intensity, depth);
  if (!movesValues(depth)) return;
  const plain = chords as unknown as Record<string, number>;
  for (const key of Object.keys(CHORD_RANGE)) {
    plain[key] = intensity === "clear" ? 0 : rollChordScalar(key, roll(key));
  }
}

function randomizeSound(
  sound: Record<string, Modulated>,
  roll: (...parts: (string | number)[]) => number,
  intensity: CaptureIntensity,
  depth: CaptureDepth,
): void {
  for (const id of Object.keys(sound)) sound[id] = touchModulated(sound[id], roll, id, intensity, depth);
}

export function audibleEvents(project: Project, phraseLanes: Record<LaneId, { velocity: number; lane: LaneId }[]>): { lane: LaneId; velocity: number }[] {
  const out: { lane: LaneId; velocity: number }[] = [];
  for (const lane of LANES) {
    if (project.mute[lane]) continue;
    for (const event of phraseLanes[lane]) {
      out.push({ lane, velocity: event.velocity * project.mixer[lane] * project.mixer.master });
    }
  }
  return out;
}
