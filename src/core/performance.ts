import { ticksPerBar } from "./clock.ts";
import { clone } from "./clone.ts";
import { hash01 } from "./hash.ts";
import { applyMorph, retarget } from "./morph.ts";
import { modulated } from "./modulate.ts";
import {
  CAPTURE_INTENSITIES,
  LANES,
  SET_CAPACITY,
  SOUND,
  WANDER_BARS,
  type CaptureIntensity,
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

const EXPENSIVE_RATE: Record<Exclude<CaptureIntensity, "clear">, number> = {
  soft: 0.15,
  medium: 0.4,
  hard: 0.75,
};

const VALUE_JITTER: Record<Exclude<CaptureIntensity, "clear">, number> = {
  soft: 0.2,
  medium: 0.45,
  hard: 1,
};

/** Weights for cycle 1..8 — peak at 4. */
const CYCLE_WEIGHTS = [1, 2, 3, 4, 3, 2, 1, 1];

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

export function sharedParamIds(): string[] {
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const lane of LANES) for (const id of SOUND[lane]) bump(id);
  for (const id of ["degree", "range", "length", "velocity", "repeat", "step"]) {
    bump(id);
    bump(id);
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([id]) => id).sort();
}

export type CaptureScope = "pattern" | "notes" | "sound" | "all";

export function setCaptureIntensity(project: Project, intensity: CaptureIntensity): Project {
  return { ...project, captureIntensity: intensity };
}

/** Reroll one page group, or the whole lane when scope is `all`. */
export function captureLane(project: Project, lane: LaneId, scope: CaptureScope = "pattern"): Project {
  if (project.lock[lane]) return project;
  if (scope === "notes" && lane !== "bass" && lane !== "lead" && lane !== "chords") return project;
  if (scope === "pattern" && lane === "chords") return project;
  const intensity = project.captureIntensity;
  const nonce = project.captureNonce + 1;
  const working = clone(project.working);
  const roll = (...parts: (string | number)[]) => hash01(project.global.seed, "capture", nonce, lane, scope, intensity, ...parts);
  if (scope === "all") {
    if (lane !== "chords") randomizePattern(working, lane, roll, intensity);
    if (lane === "bass" || lane === "lead" || lane === "chords") randomizeNotes(working, lane, roll, intensity);
    randomizeSound(working[lane].sound, roll, intensity);
  } else if (scope === "sound") randomizeSound(working[lane].sound, roll, intensity);
  else if (scope === "notes") randomizeNotes(working, lane, roll, intensity);
  else randomizePattern(working, lane, roll, intensity);
  return { ...project, working, captureNonce: nonce };
}

/** Reroll one euclid (`gen1`), its velocity, or another 4-param modulator. */
export function captureGenerator(project: Project, lane: LaneId, target: string): Project {
  if (project.lock[lane]) return project;
  const intensity = project.captureIntensity;
  const working = clone(project.working);
  const node = readNode(working[lane], target);
  const nonce = project.captureNonce + 1;
  const roll = (...parts: (string | number)[]) => hash01(project.global.seed, "capture", nonce, lane, target, intensity, ...parts);
  if (isEuclidGen(node)) {
    Object.assign(node, touchEuclid(node, roll, "", intensity));
    return { ...project, working, captureNonce: nonce };
  }
  if (isModulated(node)) {
    Object.assign(node, touchMaybeExpensive(node, roll, target, intensity, isRatchetPath(target)));
    return { ...project, working, captureNonce: nonce };
  }
  return project;
}

/**
 * Reroll only the parameters listed on one page (binding paths). Avoids importing pages.ts.
 * Groups paths into euclid roots, modulators, and scalars.
 */
export function capturePaths(project: Project, lane: LaneId, paths: string[]): Project {
  if (project.lock[lane]) return project;
  if (!paths.length) return project;
  const intensity = project.captureIntensity;
  const working = clone(project.working);
  const nonce = project.captureNonce + 1;
  const roll = (...parts: (string | number)[]) => hash01(project.global.seed, "capture", nonce, lane, "page", intensity, ...parts);
  const root = working[lane] as unknown as Record<string, unknown>;
  const seen = new Set<string>();
  for (const path of paths) {
    const target = captureTarget(path);
    if (!target || seen.has(target.key)) continue;
    seen.add(target.key);
    applyCaptureTarget(root, target, roll, intensity);
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
): void {
  if (target.kind === "euclid") {
    const node = readNode(root, target.path);
    if (isEuclidGen(node)) Object.assign(node, touchEuclid(node, roll, target.path, intensity));
    return;
  }
  if (target.kind === "modulated") {
    const node = readNode(root, target.path);
    if (isModulated(node)) {
      Object.assign(node, touchMaybeExpensive(node, roll, target.path, intensity, isRatchetPath(target.path)));
    }
    return;
  }
  if (intensity === "clear") return;
  if (typeof root[target.path] === "number") {
    const unit = roll(target.path);
    root[target.path] = target.path in CHORD_RANGE ? rollChordScalar(target.path, unit) : unit;
  }
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

/** Pick cycle 1..8 with weights peaking at 4. Exported for tests. */
export function cycleBiased(roll: number): number {
  const total = CYCLE_WEIGHTS.reduce((sum, w) => sum + w, 0);
  let edge = Math.min(0.999999, Math.max(0, roll)) * total;
  for (let i = 0; i < CYCLE_WEIGHTS.length; i++) {
    edge -= CYCLE_WEIGHTS[i];
    if (edge < 0) return i + 1;
  }
  return 8;
}

function expensiveChance(intensity: Exclude<CaptureIntensity, "clear">): number {
  return EXPENSIVE_RATE[intensity];
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
  expensiveWhole: boolean,
): Modulated {
  if (intensity === "clear") return touchModulated(current, roll, prefix, intensity);
  if (expensiveWhole && roll(prefix, "touch?") >= expensiveChance(intensity)) return current;
  return touchModulated(current, roll, prefix, intensity);
}

function touchModulated(
  current: Modulated,
  roll: (...parts: (string | number)[]) => number,
  prefix: string,
  intensity: CaptureIntensity,
): Modulated {
  if (intensity === "clear") {
    return { value: current.value, pattern: 0, cycle: current.cycle, amount: 0 };
  }
  const jitter = VALUE_JITTER[intensity];
  const value =
    intensity === "hard"
      ? roll(prefix, "v")
      : clamp01(current.value + (roll(prefix, "v") * 2 - 1) * jitter);
  let pattern = current.pattern;
  let cycle = current.cycle;
  let amount = current.amount;
  const rate = expensiveChance(intensity);
  if (roll(prefix, "p?") < rate) pattern = Math.floor(roll(prefix, "p") * 64);
  if (roll(prefix, "c?") < rate) cycle = cycleBiased(roll(prefix, "c"));
  if (roll(prefix, "a?") < rate) amount = (roll(prefix, "a") * 2 - 1) * 0.75;
  return modulated(value, pattern, cycle, amount);
}

/** Cheap pattern-gen step: nudge one of LEN/HIT/ROT/PRB by a small intensity-scaled amount. */
function nudgeEuclid(
  current: EuclidGen,
  roll: (...parts: (string | number)[]) => number,
  prefix: string,
  intensity: Exclude<CaptureIntensity, "clear">,
): EuclidGen {
  const step = intensity === "soft" ? 1 : intensity === "medium" ? 2 : 3;
  const probStep = intensity === "soft" ? 0.05 : intensity === "medium" ? 0.1 : 0.18;
  let length = Math.max(0, Math.min(64, current.length));
  let hits = Math.max(0, Math.min(length, current.hits));
  let rotate = length > 0 ? ((current.rotate % length) + length) % length : 0;
  let probability = clamp01(current.probability);
  const which = Math.floor(roll(prefix, "which") * 4);
  const sign = roll(prefix, "sign") < 0.5 ? -1 : 1;
  if (which === 0) {
    length = Math.max(0, Math.min(64, length + sign * (1 + Math.floor(roll(prefix, "len") * step))));
  } else if (which === 1) {
    hits = Math.max(0, Math.min(Math.max(length, 0), hits + sign * (1 + Math.floor(roll(prefix, "hits") * step))));
  } else if (which === 2) {
    if (length > 0) rotate = (((rotate + sign * (1 + Math.floor(roll(prefix, "rot") * step))) % length) + length) % length;
  } else {
    probability = clamp01(probability + sign * (probStep * (0.5 + roll(prefix, "prob"))));
  }
  if (length > 0) {
    hits = Math.max(0, Math.min(length, hits));
    rotate = rotate % length;
  } else {
    hits = 0;
    rotate = 0;
  }
  return { length, hits, rotate, probability, velocity: current.velocity };
}

function touchEuclid(
  current: EuclidGen,
  roll: (...parts: (string | number)[]) => number,
  prefix: string,
  intensity: CaptureIntensity,
): EuclidGen {
  if (intensity === "clear") {
    return {
      ...current,
      velocity: touchModulated(current.velocity, roll, `${prefix}.velocity`, intensity),
    };
  }
  const nudged = nudgeEuclid(current, roll, prefix, intensity);
  return {
    ...nudged,
    velocity: touchModulated(current.velocity, roll, `${prefix}.velocity`, intensity),
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
): void {
  if (lane === "chords") return;
  const target = lanes[lane];
  target.gen1 = touchEuclid(target.gen1, roll, "gen1", intensity);
  target.gen2 = touchEuclid(target.gen2, roll, "gen2", intensity);
  if (lane === "bass" || lane === "lead") {
    if (intensity !== "clear") lanes[lane].follow = roll("follow");
    return;
  }
  const drum = lanes[lane];
  drum.ratchet.count = touchMaybeExpensive(drum.ratchet.count, roll, "ratchet.count", intensity, true);
  drum.ratchet.rate = touchMaybeExpensive(drum.ratchet.rate, roll, "ratchet.rate", intensity, true);
}

function randomizeNotes(
  lanes: Lanes,
  lane: LaneId,
  roll: (...parts: (string | number)[]) => number,
  intensity: CaptureIntensity,
): void {
  if (lane === "bass" || lane === "lead") {
    const pitched = lanes[lane];
    pitched.degree = touchModulated(pitched.degree, roll, "degree", intensity);
    pitched.range = touchModulated(pitched.range, roll, "range", intensity);
    pitched.length = touchModulated(pitched.length, roll, "length", intensity);
    pitched.repeat = touchModulated(pitched.repeat, roll, "repeat", intensity);
    pitched.step = touchModulated(pitched.step, roll, "step", intensity);
    if (intensity !== "clear") pitched.follow = roll("follow");
    return;
  }
  if (lane !== "chords") return;
  const chords = lanes.chords;
  chords.rate = touchModulated(chords.rate, roll, "rate", intensity);
  chords.gate = touchModulated(chords.gate, roll, "gate", intensity);
  if (intensity === "clear") return;
  const plain = chords as unknown as Record<string, number>;
  for (const key of Object.keys(CHORD_RANGE)) plain[key] = rollChordScalar(key, roll(key));
}

function randomizeSound(
  sound: Record<string, Modulated>,
  roll: (...parts: (string | number)[]) => number,
  intensity: CaptureIntensity,
): void {
  for (const id of Object.keys(sound)) sound[id] = touchModulated(sound[id], roll, id, intensity);
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
