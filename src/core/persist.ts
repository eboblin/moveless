import { defaultProject } from "./defaults.ts";
import { clone } from "./clone.ts";
import {
  CAPTURE_INTENSITIES,
  LANES,
  SCALE_IDS,
  type CaptureIntensity,
  type ChordLane,
  type ContextId,
  type Lanes,
  type Project,
  type TransitionId,
  type WanderId,
} from "./types.ts";
import { pageCount } from "../ui/pages.ts";

export const STORE_VERSION = 1;
export const PROJECT_DIR = "/data/UserData/schwung/ptnmove";
export const PROJECT_PATH = `${PROJECT_DIR}/project.json`;

export interface StoredUi {
  context: ContextId;
  page: number;
  mode: "journal" | "set";
}

export interface StoredBundle {
  project: Project;
  ui: StoredUi;
}

/** Subset of Schwung host filesystem bindings used for project I/O. */
export interface HostFiles {
  ensure_dir?: (path: string) => boolean | void;
  file_exists?: (path: string) => boolean;
  read_file?: (path: string) => string | null;
  write_file?: (path: string, content: string) => boolean;
}

const CONTEXTS: readonly ContextId[] = [...LANES, "mix", "global"];
const TRANSITIONS: readonly TransitionId[] = ["now", "fast", "medium", "slow"];
const WANDERS: readonly WanderId[] = ["fast", "medium", "slow", "glacial"];

/** Drop tick-bound runtime before save/load. */
export function sanitizeProject(project: Project): Project {
  const next = clone(project);
  next.morph = null;
  next.wanderOriginTick = 0;
  if (next.clipboardSceneId && !next.journal.some((scene) => scene.id === next.clipboardSceneId)) {
    next.clipboardSceneId = null;
  }
  return next;
}

export function serializeStored(project: Project, ui: StoredUi): string {
  return JSON.stringify({
    version: STORE_VERSION,
    project: sanitizeProject(project),
    ui: { context: ui.context, page: ui.page, mode: ui.mode },
  });
}

export function parseStored(raw: string): StoredBundle | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  if (root.version !== STORE_VERSION) return null;
  if (!root.project || typeof root.project !== "object") return null;
  const source = root.project as Record<string, unknown>;
  const project = resetStaleChords(mergeProject(source), source);
  const ui = mergeUi(root.ui, project);
  return { project: sanitizeProject(project), ui };
}

export function loadStoredProject(files: HostFiles): StoredBundle | null {
  if (!files.read_file) return null;
  const raw = files.read_file(PROJECT_PATH);
  if (raw == null || raw === "") return null;
  return parseStored(raw);
}

export function saveStoredProject(project: Project, ui: StoredUi, files: HostFiles): boolean {
  if (!files.write_file) return false;
  files.ensure_dir?.(PROJECT_DIR);
  return files.write_file(PROJECT_PATH, serializeStored(project, ui)) === true;
}

function mergeProject(raw: Record<string, unknown>): Project {
  const base = defaultProject();
  const journal = Array.isArray(raw.journal) ? raw.journal : base.journal;
  const sets = Array.isArray(raw.sets) ? raw.sets : base.sets;
  const bookmarkRaw = raw.bookmarks;
  const bookmarks = Array.isArray(bookmarkRaw)
    ? [0, 1, 2, 3].map((i) => {
        const ref = bookmarkRaw[i];
        if (!ref || typeof ref !== "object") return null;
        const item = ref as Record<string, unknown>;
        const context = asContext(item.context);
        const page = asInt(item.page, 0);
        return context ? { context, page: Math.max(0, page) } : null;
      })
    : base.bookmarks;
  return {
    ...base,
    motifBankVersion: asInt(raw.motifBankVersion, base.motifBankVersion),
    nextSceneId: Math.max(1, asInt(raw.nextSceneId, base.nextSceneId)),
    journal: journal as Project["journal"],
    sets: sets as Project["sets"],
    activeSetId: typeof raw.activeSetId === "string" || raw.activeSetId === null ? (raw.activeSetId as string | null) : base.activeSetId,
    mixer: { ...base.mixer, ...(isRecord(raw.mixer) ? (raw.mixer as Project["mixer"]) : {}) },
    global: mergeGlobal(base.global, raw.global),
    macros: isRecord(raw.macros) ? { ...base.macros, ...(raw.macros as Record<string, number>) } : base.macros,
    bookmarks,
    mute: { ...base.mute, ...(isRecord(raw.mute) ? (raw.mute as Project["mute"]) : {}) },
    lock: { ...base.lock, ...(isRecord(raw.lock) ? (raw.lock as Project["lock"]) : {}) },
    working: mergeWorking(base.working, raw.working),
    transition: asTransition(raw.transition) ?? base.transition,
    wander: raw.wander === null ? null : asWander(raw.wander) ?? base.wander,
    wanderPreviousTarget:
      typeof raw.wanderPreviousTarget === "string" || raw.wanderPreviousTarget === null
        ? (raw.wanderPreviousTarget as string | null)
        : base.wanderPreviousTarget,
    wanderOriginTick: 0,
    activeSceneId:
      typeof raw.activeSceneId === "string" || raw.activeSceneId === null
        ? (raw.activeSceneId as string | null)
        : base.activeSceneId,
    morph: null,
    clipboardSceneId:
      typeof raw.clipboardSceneId === "string" || raw.clipboardSceneId === null
        ? (raw.clipboardSceneId as string | null)
        : base.clipboardSceneId,
    captureNonce: Math.max(0, asInt(raw.captureNonce, base.captureNonce)),
    captureIntensity: asIntensity(raw.captureIntensity) ?? base.captureIntensity,
  };
}

function currentChords(raw: unknown): ChordLane {
  const base = clone(defaultProject().working.chords);
  if (!isRecord(raw) || typeof raw.start !== "number") return base;
  const merged = deepMerge(base, raw) as ChordLane & { strum?: { value?: number } };
  const strumValue = merged.strum?.value;
  delete merged.strum;
  if (typeof strumValue === "number" && strumValue > 0 && merged.rate.value <= 0) {
    merged.rate = { ...merged.rate, value: Math.min(1, strumValue) };
  }
  return merged;
}

/** A chord lane without `start` is the previous shape. Replace it; do not translate fields. */
function resetStaleChords(project: Project, raw: Record<string, unknown>): Project {
  if (isRecord(raw.working)) project.working.chords = currentChords(raw.working.chords);
  if (Array.isArray(raw.journal)) {
    raw.journal.forEach((scene, index) => {
      const saved = project.journal[index];
      if (!isRecord(scene) || !isRecord(scene.lanes) || !saved?.lanes) return;
      saved.lanes.chords = currentChords(scene.lanes.chords);
    });
  }
  return project;
}

function mergeUi(raw: unknown, project: Project): StoredUi {
  const base: StoredUi = { context: "kick", page: 0, mode: "journal" };
  if (!isRecord(raw)) return base;
  const context = asContext(raw.context) ?? base.context;
  const mode = raw.mode === "set" || raw.mode === "journal" ? raw.mode : base.mode;
  const count = Math.max(1, pageCount(context));
  const page = Math.min(Math.max(0, asInt(raw.page, 0)), count - 1);
  void project;
  return { context, page, mode };
}

function mergeGlobal(base: Project["global"], raw: unknown): Project["global"] {
  if (!isRecord(raw)) return { ...base };
  const scale = typeof raw.scale === "string" && (SCALE_IDS as readonly string[]).includes(raw.scale) ? (raw.scale as Project["global"]["scale"]) : base.scale;
  return {
    ...base,
    tempo: clamp(asNumber(raw.tempo, base.tempo), 40, 240),
    swing: clamp(asNumber(raw.swing, base.swing), 0, 1),
    root: Math.max(0, Math.min(11, asInt(raw.root, base.root))),
    scale,
    transpose: Math.max(-24, Math.min(24, asInt(raw.transpose, base.transpose))),
    bar: Math.max(1, Math.min(16, asInt(raw.bar, base.bar))),
    phrase: Math.max(1, Math.min(64, asInt(raw.phrase, base.phrase))),
    seed: Math.max(0, Math.min(999, asInt(raw.seed, base.seed))),
  };
}

function mergeWorking(base: Lanes, raw: unknown): Lanes {
  if (!isRecord(raw)) return clone(base);
  const out = clone(base) as unknown as Record<string, unknown>;
  for (const lane of LANES) {
    if (isRecord(raw[lane])) out[lane] = deepMerge(out[lane], raw[lane]);
  }
  return out as unknown as Lanes;
}

function deepMerge(base: unknown, raw: unknown): unknown {
  if (Array.isArray(base)) return Array.isArray(raw) ? raw : base;
  if (!isRecord(base) || !isRecord(raw)) return raw === undefined ? base : raw;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(raw)) {
    out[key] = key in base ? deepMerge(base[key], raw[key]) : raw[key];
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asContext(value: unknown): ContextId | null {
  return typeof value === "string" && (CONTEXTS as readonly string[]).includes(value) ? (value as ContextId) : null;
}

function asTransition(value: unknown): TransitionId | null {
  return typeof value === "string" && (TRANSITIONS as readonly string[]).includes(value) ? (value as TransitionId) : null;
}

function asWander(value: unknown): WanderId | null {
  return typeof value === "string" && (WANDERS as readonly string[]).includes(value) ? (value as WanderId) : null;
}

function asIntensity(value: unknown): CaptureIntensity | null {
  return typeof value === "string" && (CAPTURE_INTENSITIES as readonly string[]).includes(value)
    ? (value as CaptureIntensity)
    : null;
}
