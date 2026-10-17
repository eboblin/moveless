import { clamp01, ticksPerBar } from "./clock.ts";
import { clone } from "./clone.ts";
import { defaultProject } from "./defaults.ts";
import { fieldsOf } from "./fields.ts";
import { hash01 } from "./hash.ts";
import { applyMorph, retarget } from "./morph.ts";
import {
  isDrum,
  isPitched,
  SET_CAPACITY,
  WANDER_BARS,
  type LaneId,
  type Project,
  type Scene,
  type WanderId,
} from "./types.ts";

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

/** Factory parameters for one lane. Mute, lock and the mixer stay. A running morph keeps the reset. */
export function resetLane(project: Project, lane: LaneId): Project {
  const working = clone(project.working);
  const home = clone(defaultProject().working);
  if (isDrum(lane)) working[lane] = home[lane];
  else if (isPitched(lane)) working[lane] = home[lane];
  else working.chords = home.chords;
  if (!project.morph) return { ...project, working };
  const prefix = `${lane}.`;
  const punched = project.morph.punched.slice();
  for (const field of fieldsOf(working)) {
    if (!field.path.startsWith(prefix) || punched.includes(field.path)) continue;
    punched.push(field.path);
  }
  return { ...project, working, morph: { ...project.morph, punched } };
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
  return clamp01(value);
}
