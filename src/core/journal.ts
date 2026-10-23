import { isDeckSlot, writeDeckKnob } from "./deck.ts";
import { clamp01, ticksPerBar } from "./clock.ts";
import { clone } from "./clone.ts";
import { defaultProject } from "./defaults.ts";
import { fieldsOf, getPath, setPath } from "./fields.ts";
import { pagesFor } from "./pages.ts";
import { hash01 } from "./hash.ts";
import { applyMorph, retarget } from "./morph.ts";
import {
  isDrum,
  isPitched,
  LANES,
  PATTERN_LANES,
  SET_CAPACITY,
  WANDER_BARS,
  type LaneId,
  type PatternId,
  type Project,
  type Scene,
  type Bus,
  type Fx,
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

/** Page 0 is the newest window of 32. Higher pages are older. */
export function journalPageCount(sceneCount: number): number {
  return Math.max(1, Math.ceil(sceneCount / SET_CAPACITY));
}

export function clampJournalPage(page: number, sceneCount: number): number {
  return Math.max(0, Math.min(page, journalPageCount(sceneCount) - 1));
}

export function journalPadIds(project: Project, page = 0): (string | null)[] {
  const slots = emptyPads();
  const clamped = clampJournalPage(page, project.journal.length);
  const end = project.journal.length - clamped * SET_CAPACITY;
  const start = Math.max(0, end - SET_CAPACITY);
  project.journal.slice(start, end).forEach((scene, index) => {
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

/** Set mode stays inside the active set. Journal mode uses the page on screen. */
export function wanderCandidates(project: Project, mode: "journal" | "set", journalPage = 0): (string | null)[] {
  if (mode === "set") return setPadIds(project);
  return journalPadIds(project, journalPage);
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

export function advance(project: Project, tick: number, candidates?: readonly (string | null)[]): Project {
  let next = applyMorph(project, tick);
  if (!next.wander) return next;
  const interval = WANDER_BARS[next.wander] * ticksPerBar(next.global.bar);
  let origin = next.wanderOriginTick;
  let guard = 0;
  while (tick - origin >= interval && guard < 8) {
    origin += interval;
    const pool = candidates ?? sceneIdsForPads(next);
    const pick = pickWanderCandidate(pool.filter((id): id is string => id !== null), next.wanderPreviousTarget, next.global.seed, origin);
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
  if (rate === null) return { ...project, wander: null };
  if (project.wander === rate) return project;
  return { ...project, wander: rate, wanderOriginTick: tick };
}

export function toggleMute(project: Project, lane: PatternId): Project {
  return { ...project, mute: { ...project.mute, [lane]: !project.mute[lane] } };
}

export function toggleSolo(project: Project, lane: LaneId): Project {
  return { ...project, solo: { ...project.solo, [lane]: !project.solo[lane] } };
}

/** Explicit mute wins. With any solo up, only soloed lanes that are not muted are heard. */
export function laneHeard(project: Project, lane: LaneId): boolean {
  if (project.mute[lane]) return false;
  let anySolo = false;
  for (const id of LANES) if (project.solo[id]) anySolo = true;
  return !anySolo || project.solo[lane];
}

export function toggleLock(project: Project, lane: PatternId): Project {
  return { ...project, lock: { ...project.lock, [lane]: !project.lock[lane] } };
}

/** Wet reverb and delay. Mute on the fx lane zeroes the returns and leaves the knobs. */
export function heardFx(project: Project): Fx {
  const fx = project.working.fx;
  if (!project.mute.fx) return fx;
  return {
    reverb: { ...fx.reverb, level: 0 },
    delay: { ...fx.delay, level: 0 },
  };
}

/** Factory parameters for one lane. Mute, lock and the mixer stay. A running morph keeps the reset. */
export function resetLane(project: Project, lane: PatternId): Project {
  const working = clone(project.working);
  const home = clone(defaultProject().working);
  if (lane === "fx") working.fx = clone(home.fx);
  else if (isDrum(lane)) working[lane] = home[lane];
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

function freshSetId(sets: { id: string }[]): string {
  const used = new Set(sets.map((set) => set.id));
  let n = sets.length + 1;
  while (used.has(`set-${n}`)) n += 1;
  return `set-${n}`;
}

export function createSet(project: Project, name: string): Project {
  const id = freshSetId(project.sets);
  const set = { id, name, sceneIds: [] as string[] };
  return { ...project, sets: [...project.sets, set], activeSetId: set.id };
}

/** One empty set after the last filled one. An empty project gets a single empty set and it becomes active. */
export function ensureTrailingEmpty(project: Project): Project {
  if (!project.sets.length) {
    const set = { id: "set-1", name: "1", sceneIds: [] as string[] };
    return { ...project, sets: [set], activeSetId: set.id };
  }
  const last = project.sets[project.sets.length - 1];
  const sets = last.sceneIds.length > 0
    ? [...project.sets, { id: freshSetId(project.sets), name: String(project.sets.length + 1), sceneIds: [] as string[] }]
    : project.sets;
  const activeSetId = project.activeSetId && sets.some((set) => set.id === project.activeSetId)
    ? project.activeSetId
    : sets[0].id;
  if (sets === project.sets && activeSetId === project.activeSetId) return project;
  return { ...project, sets, activeSetId };
}

/** Journal always. Set mode also links the new scene onto the active set. */
export function recordInto(project: Project, intoSet: boolean): Project {
  let next = record(project);
  if (!intoSet) return next;
  next = ensureTrailingEmpty(next);
  const id = next.activeSceneId;
  if (id && next.activeSetId) next = addSceneToSet(next, next.activeSetId, id);
  return ensureTrailingEmpty(next);
}

export function cycleSet(project: Project, direction: number): Project {
  if (!project.sets.length) return project;
  const index = Math.max(0, project.sets.findIndex((set) => set.id === project.activeSetId));
  const next = (index + direction + project.sets.length) % project.sets.length;
  return { ...project, activeSetId: project.sets[next].id };
}

export function toggleClipboard(project: Project, sceneId: string): Project {
  if (!project.journal.some((scene) => scene.id === sceneId)) return project;
  const has = project.clipboardSceneIds.includes(sceneId);
  return {
    ...project,
    clipboardSceneIds: has
      ? project.clipboardSceneIds.filter((id) => id !== sceneId)
      : [...project.clipboardSceneIds, sceneId],
  };
}

/** Append marked scenes that still fit. Links already in the set are skipped. */
export function pasteClipboard(project: Project): Project {
  let next = project.activeSetId ? project : ensureTrailingEmpty(project);
  const setId = next.activeSetId;
  if (!setId) return next;
  for (const id of next.clipboardSceneIds) next = addSceneToSet(next, setId, id);
  const placed = new Set(next.sets.find((set) => set.id === setId)?.sceneIds ?? []);
  next = { ...next, clipboardSceneIds: next.clipboardSceneIds.filter((id) => !placed.has(id)) };
  return ensureTrailingEmpty(next);
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
    clipboardSceneIds: project.clipboardSceneIds.filter((id) => id !== sceneId),
    activeSceneId: project.activeSceneId === sceneId ? null : project.activeSceneId,
    wanderPreviousTarget: project.wanderPreviousTarget === sceneId ? null : project.wanderPreviousTarget,
    morph: project.morph?.targetId === sceneId ? null : project.morph,
  };
}

export function deleteSet(project: Project, setId: string): Project {
  const sets = project.sets.filter((set) => set.id !== setId);
  const activeSetId = project.activeSetId === setId ? (sets[0]?.id ?? null) : project.activeSetId;
  return ensureTrailingEmpty({ ...project, sets, activeSetId });
}

export function setMacro(project: Project, id: string, offset: number): Project {
  return { ...project, macros: { ...project.macros, [id]: offset } };
}

/**
 * Write one macro into the value of every unlocked lane it feeds, then clear it.
 * Pattern, cycle, and amount stay. A locked lane is left alone. The heard sum
 * does not move: the offset leaves the macro and lands in the stored value.
 */
export function commitMacro(project: Project, key: string): Project {
  const offset = project.macros[key] ?? 0;
  if (offset === 0) return project;
  const working = clone(project.working);
  const punched = project.morph ? project.morph.punched.slice() : null;
  for (const lane of PATTERN_LANES) {
    if (project.lock[lane]) continue;
    for (const item of pagesFor(lane)) {
      for (const binding of item.bindings) {
        if (!binding?.macro?.includes(key)) continue;
        const full = `${lane}.${binding.path}`;
        let next = getPath(working, full) + offset;
        if (next < binding.min) next = binding.min;
        if (next > binding.max) next = binding.max;
        if (binding.integer) next = Math.round(next);
        setPath(working, full, next);
        if (punched && !punched.includes(full)) punched.push(full);
      }
    }
  }
  const macros = { ...project.macros, [key]: 0 };
  if (!project.morph || !punched) return { ...project, working, macros };
  return { ...project, working, macros, morph: { ...project.morph, punched } };
}

export function setDeck(project: Project, id: string, value: number): Project {
  if (!isDeckSlot(id)) return project;
  return { ...project, deck: writeDeckKnob(project.deck, id, value, project.global.bar) };
}

export function setBus(project: Project, id: keyof Bus, value: number): Project {
  return { ...project, bus: { ...project.bus, [id]: value } };
}

export function setMixer(project: Project, id: LaneId | "master", value: number): Project {
  return { ...project, mixer: { ...project.mixer, [id]: clampMixer(value) } };
}

function clampMixer(value: number): number {
  return clamp01(value);
}
