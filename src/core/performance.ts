import { ticksPerBar } from "./clock.ts";
import { clone } from "./clone.ts";
import { hash01 } from "./hash.ts";
import { applyMorph, retarget } from "./morph.ts";
import { modulated } from "./modulate.ts";
import {
  LANES,
  SET_CAPACITY,
  SOUND,
  WANDER_BARS,
  type EuclidGen,
  type LaneId,
  type Lanes,
  type Project,
  type Scene,
  type WanderId,
} from "./types.ts";

const SCENE_COLORS = [1, 3, 5, 8, 9, 11, 14, 16, 17, 20, 22, 23, 25, 28, 32, 126];

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
  for (const id of ["change", "length", "motion", "variation", "mood", "tension"]) bump(id);
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([id]) => id).sort();
}

export type CaptureScope = "pattern" | "notes" | "sound" | "all";

/** Reroll one page group, or the whole lane when scope is `all`. */
export function captureLane(project: Project, lane: LaneId, scope: CaptureScope = "pattern"): Project {
  if (project.lock[lane]) return project;
  if (scope === "notes" && lane !== "bass" && lane !== "lead" && lane !== "chords") return project;
  if (scope === "pattern" && lane === "chords") return project;
  const nonce = project.captureNonce + 1;
  const working = clone(project.working);
  const roll = (...parts: (string | number)[]) => hash01(project.global.seed, "capture", nonce, lane, scope, ...parts);
  if (scope === "all") {
    if (lane !== "chords") randomizePattern(working, lane, roll);
    if (lane === "bass" || lane === "lead" || lane === "chords") randomizeNotes(working, lane, roll);
    randomizeSound(working[lane].sound, roll);
  } else if (scope === "sound") randomizeSound(working[lane].sound, roll);
  else if (scope === "notes") randomizeNotes(working, lane, roll);
  else randomizePattern(working, lane, roll);
  return { ...project, working, captureNonce: nonce };
}

/** Reroll one euclid (`gen1`), its velocity, or another 4-param modulator. */
export function captureGenerator(project: Project, lane: LaneId, target: string): Project {
  if (project.lock[lane]) return project;
  const working = clone(project.working);
  const node = readNode(working[lane], target);
  const nonce = project.captureNonce + 1;
  const roll = (...parts: (string | number)[]) => hash01(project.global.seed, "capture", nonce, lane, target, ...parts);
  if (isEuclidGen(node)) {
    Object.assign(node, randomEuclid(roll));
    return { ...project, working, captureNonce: nonce };
  }
  if (isModulated(node)) {
    node.value = roll("v");
    node.pattern = Math.floor(roll("p") * 64);
    node.cycle = 1 + Math.floor(roll("c") * 8);
    node.amount = (roll("a") * 2 - 1) * 0.75;
    return { ...project, working, captureNonce: nonce };
  }
  return project;
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

function isModulated(value: unknown): value is { value: number; pattern: number; cycle: number; amount: number } {
  return !!value && typeof value === "object" && "amount" in value && "pattern" in value && "cycle" in value;
}

function randomEuclid(roll: (...parts: (string | number)[]) => number): EuclidGen {
  const length = 4 + Math.floor(roll("len") * 13);
  const hits = Math.floor(roll("hits") * (length + 1));
  return {
    length,
    hits,
    rotate: Math.floor(roll("rot") * length),
    probability: 0.35 + roll("prob") * 0.65,
    velocity: modulated(
      0.35 + roll("vel") * 0.65,
      Math.floor(roll("vp") * 64),
      1 + Math.floor(roll("vc") * 8),
      (roll("va") * 2 - 1) * 0.75,
    ),
  };
}

function touch(roll: (...parts: (string | number)[]) => number, prefix: string) {
  return modulated(
    roll(prefix, "v"),
    Math.floor(roll(prefix, "p") * 64),
    1 + Math.floor(roll(prefix, "c") * 8),
    (roll(prefix, "a") * 2 - 1) * 0.75,
  );
}

function randomizePattern(lanes: Lanes, lane: LaneId, roll: (...parts: (string | number)[]) => number): void {
  if (lane === "chords") return;
  const target = lanes[lane];
  target.gen1 = randomEuclid((...parts) => roll("gen1", ...parts));
  target.gen2 = randomEuclid((...parts) => roll("gen2", ...parts));
  if (lane === "bass" || lane === "lead") {
    target.follow = roll("follow");
  } else {
    const drum = lanes[lane];
    drum.ratchet.count = touch(roll, "ratchet.count");
    drum.ratchet.rate = touch(roll, "ratchet.rate");
  }
}

function randomizeNotes(lanes: Lanes, lane: LaneId, roll: (...parts: (string | number)[]) => number): void {
  if (lane === "bass" || lane === "lead") {
    const pitched = lanes[lane];
    pitched.degree = touch(roll, "degree");
    pitched.range = touch(roll, "range");
    pitched.length = touch(roll, "length");
    pitched.repeat = touch(roll, "repeat");
    pitched.step = touch(roll, "step");
    pitched.follow = roll("follow");
    return;
  }
  if (lane !== "chords") return;
  const chords = lanes.chords;
  chords.change = touch(roll, "change");
  chords.length = touch(roll, "length");
  chords.motion = touch(roll, "motion");
  chords.variation = touch(roll, "variation");
  chords.mood = touch(roll, "mood");
  chords.tension = touch(roll, "tension");
  chords.play = {
    mode: Math.floor(roll("mode") * 4),
    rate: Math.floor(roll("rate") * 6),
    gate: roll("gate"),
    octaves: 1 + Math.floor(roll("oct") * 4),
    spread: roll("spread"),
    flow: roll("flow"),
    strum: roll("strum"),
    direction: Math.floor(roll("dir") * 3),
  };
}

function randomizeSound(sound: Record<string, ReturnType<typeof modulated>>, roll: (...parts: (string | number)[]) => number): void {
  for (const id of Object.keys(sound)) sound[id] = touch(roll, id);
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
