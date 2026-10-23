import { defaultDeck, groupIndex, migrateDeckIndex, type DeckCell } from "./deck.ts";
import { defaultProject } from "./defaults.ts";
import { clone } from "./clone.ts";
import { ensureTrailingEmpty } from "./journal.ts";
import {
  RANDOMIZE_DEPTHS,
  RANDOMIZE_INTENSITIES,
  RANDOMIZE_SCOPES,
  PATTERN_LANES,
  PROGRESSION_KEYS,
  SCALE_IDS,
  STEPS,
  TRANSITIONS,
  WANDERS,
  type RandomizeDepth,
  type RandomizeIntensity,
  type RandomizeScope,
  type ContextId,
  type Lanes,
  type Progression,
  type PatternId,
  type Project,
  type TransitionId,
  type WanderId,
} from "./types.ts";
import { pageCount } from "./pages.ts";

export const STORE_VERSION = 1;
export const PROJECT_DIR = "/data/UserData/schwung/ptnmove";
export const PROJECT_PATH = `${PROJECT_DIR}/project.json`;

export interface StoredUi {
  context: ContextId;
  page: number;
  mode: "journal" | "set";
  /** Transport. A file written before this field boots running. */
  playing: boolean;
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

const CONTEXTS: readonly ContextId[] = STEPS;

/** Drop tick-bound runtime before save/load. */
export function sanitizeProject(project: Project): Project {
  const next = clone(project);
  next.morph = null;
  next.wanderOriginTick = 0;
  const known = new Set(next.journal.map((scene) => scene.id));
  next.clipboardSceneIds = next.clipboardSceneIds.filter((id) => known.has(id));
  return next;
}

export function serializeStored(project: Project, ui: StoredUi): string {
  return JSON.stringify({
    version: STORE_VERSION,
    project: sanitizeProject(project),
    ui: { context: ui.context, page: ui.page, mode: ui.mode, playing: ui.playing },
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
  const project = mergeProject(source);
  const ui = mergeUi(root.ui);
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
  return ensureTrailingEmpty({
    ...base,
    motifBankVersion: asInt(raw.motifBankVersion, base.motifBankVersion),
    nextSceneId: Math.max(1, asInt(raw.nextSceneId, base.nextSceneId)),
    journal: acceptJournal(journal),
    sets: sets as Project["sets"],
    activeSetId: typeof raw.activeSetId === "string" || raw.activeSetId === null ? (raw.activeSetId as string | null) : base.activeSetId,
    mixer: { ...base.mixer, ...(isRecord(raw.mixer) ? (raw.mixer as Project["mixer"]) : {}) },
    global: mergeGlobal(base.global, raw.global),
    macros: isRecord(raw.macros) ? { ...base.macros, ...(raw.macros as Record<string, number>) } : base.macros,
    bus: mergeBus(base.bus, raw.bus),
    deck: mergeDeck(base.deck, raw.deck),
    bookmarks,
    mute: { ...base.mute, ...(isRecord(raw.mute) ? (raw.mute as Project["mute"]) : {}) },
    solo: { ...base.solo, ...(isRecord(raw.solo) ? (raw.solo as Project["solo"]) : {}) },
    lock: { ...base.lock, ...(isRecord(raw.lock) ? (raw.lock as Project["lock"]) : {}) },
    working: acceptLanes(raw.working),
    progression: mergeProgression(base.progression, raw.progression),
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
    clipboardSceneIds: acceptClipboard(raw, acceptJournal(journal)),
    randomizeNonce: Math.max(0, asInt(raw.randomizeNonce ?? raw.captureNonce, base.randomizeNonce)),
    randomizeIntensity: asIntensity(raw.randomizeIntensity) ?? asIntensity(raw.captureIntensity) ?? base.randomizeIntensity,
    randomizeScope: asScope(raw.randomizeScope) ?? asScope(raw.captureScope) ?? base.randomizeScope,
    randomizeDepth: asDepth(raw.randomizeDepth) ?? asDepth(raw.captureDepth) ?? base.randomizeDepth,
  });
}

function acceptClipboard(raw: Record<string, unknown>, journal: { id: string }[]): string[] {
  const known = new Set(journal.map((scene) => scene.id));
  const list = Array.isArray(raw.clipboardSceneIds)
    ? raw.clipboardSceneIds
    : typeof raw.clipboardSceneId === "string"
      ? [raw.clipboardSceneId]
      : [];
  return list.filter((id): id is string => typeof id === "string" && known.has(id));
}

function mergeUi(raw: unknown): StoredUi {
  const base: StoredUi = { context: "kick", page: 0, mode: "journal", playing: true };
  if (!isRecord(raw)) return base;
  const context = asContext(raw.context) ?? base.context;
  const mode = raw.mode === "set" || raw.mode === "journal" ? raw.mode : base.mode;
  const count = Math.max(1, pageCount(context));
  const page = Math.min(Math.max(0, asInt(raw.page, 0)), count - 1);
  const playing = raw.playing === false ? false : true;
  return { context, page, mode, playing };
}

const PROGRESSION_CLAMP: Record<(typeof PROGRESSION_KEYS)[number], [number, number, boolean]> = {
  start: [-7, 7, true],
  count: [0, 16, true],
  length: [0, 4, true],
  motion: [0, 7, true],
  variation: [0, 3, true],
  mood: [0, 1, false],
  tension: [0, 1, false],
  way: [0, 3, true],
};

function mergeProgression(base: Progression, raw: unknown): Progression {
  if (!isRecord(raw)) return { ...base };
  const merged = mergeKnown(base, raw) as Progression;
  for (const key of PROGRESSION_KEYS) {
    const [min, max, integer] = PROGRESSION_CLAMP[key];
    const n = integer ? asInt(merged[key], base[key]) : asNumber(merged[key], base[key]);
    merged[key] = clamp(n, min, max);
  }
  return merged;
}

function mergeCells(raw: unknown, home: DeckCell[]): DeckCell[] {
  if (!Array.isArray(raw) || raw.length !== 8) return home.map((cell) => ({ ...cell }));
  return raw.map((item, index) => {
    const cell = isRecord(item) ? item : {};
    const fallback = home[index] ?? { x: 0, y: 0 };
    return {
      x: clamp(asInt(cell.x, fallback.x), 0, 5),
      y: clamp(asInt(cell.y, fallback.y), 0, 3),
    };
  });
}

function mergeDeck(base: Project["deck"], raw: unknown): Project["deck"] {
  if (!isRecord(raw)) return { ...base, cells: base.cells.map((cell) => ({ ...cell })) };
  const home = defaultDeck();
  const legacy = !Array.isArray(raw.cells);
  const cells = mergeCells(raw.cells, home.cells);
  if (legacy && raw.shape !== undefined) cells[groupIndex("scr")].y = clamp(asInt(raw.shape, 0), 0, 3);
  return {
    div: clamp(legacy ? migrateDeckIndex("div", asInt(raw.div, 2)) : asInt(raw.div, home.div), 0, 5),
    len: clamp(asNumber(raw.len, home.len), 0, 1),
    depth: clamp(asNumber(raw.depth, home.depth), 0, 1),
    brake: clamp(legacy ? migrateDeckIndex("brake", asInt(raw.brake, 2)) : asInt(raw.brake, home.brake), 0, 5),
    vary: clamp(asNumber(raw.vary, 0), 0, 1),
    quant: clamp(asInt(raw.quant, home.quant), 0, 3),
    duty: clamp(asNumber(raw.duty, home.duty), 0, 1),
    ramp: clamp(asNumber(raw.ramp, home.ramp), 0, 1),
    cells,
    focus: clamp(asInt(raw.focus, home.focus), 0, 7),
  };
}

function mergeBus(base: Project["bus"], raw: unknown): Project["bus"] {
  if (!isRecord(raw)) return { ...base };
  return {
    glue: clamp(asNumber(raw.glue, base.glue), 0, 1),
    pump: clamp(asNumber(raw.pump, base.pump), 0, 1),
    wide: clamp(asNumber(raw.wide, base.wide), 0, 1),
    tilt: clamp(asNumber(raw.tilt, base.tilt), -1, 1),
  };
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

function hasValue(value: unknown): boolean {
  return isRecord(value) && typeof value.value === "number";
}

/** Current lane shape only. Anything older is unreadable and stays at the factory lane. */
function laneCurrent(id: PatternId, raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (id === "fx") return isRecord(raw.reverb) && typeof raw.reverb.size === "number" && isRecord(raw.delay);
  if (id === "chords") return hasValue(raw.tone) && hasValue(raw.octave) && hasValue(raw.rate);
  if (id === "bass" || id === "lead") return hasValue(raw.pitch) && hasValue(raw.octave);
  return isRecord(raw.gen1) && typeof raw.gen1.hits === "number" && isRecord(raw.ratchet) && hasValue(raw.ratchet.count);
}

function acceptLanes(raw: unknown): Lanes {
  const base = clone(defaultProject().working);
  if (!isRecord(raw)) return base;
  const out = base as unknown as Record<string, unknown>;
  for (const lane of PATTERN_LANES) {
    if (!laneCurrent(lane, raw[lane])) continue;
    out[lane] = mergeKnown(out[lane], raw[lane]);
  }
  return out as unknown as Lanes;
}

function acceptJournal(raw: unknown): Project["journal"] {
  if (!Array.isArray(raw)) return [];
  const scenes: Project["journal"] = [];
  for (const scene of raw) {
    if (!isRecord(scene) || typeof scene.id !== "string") continue;
    scenes.push({
      id: scene.id,
      color: typeof scene.color === "number" ? scene.color : undefined,
      lanes: acceptLanes(scene.lanes),
    });
  }
  return scenes;
}

/** Copy only keys the current value already has. Unrecognized fields are dropped. */
function mergeKnown(base: unknown, raw: unknown): unknown {
  if (Array.isArray(base)) return Array.isArray(raw) ? raw : base;
  if (!isRecord(base) || !isRecord(raw)) return raw === undefined ? base : raw;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    out[key] = key in raw ? mergeKnown(base[key], raw[key]) : base[key];
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
  if (value === "glacial") return "slow";
  return typeof value === "string" && (WANDERS as readonly string[]).includes(value) ? (value as WanderId) : null;
}

function asIntensity(value: unknown): RandomizeIntensity | null {
  return typeof value === "string" && (RANDOMIZE_INTENSITIES as readonly string[]).includes(value)
    ? (value as RandomizeIntensity)
    : null;
}

function asScope(value: unknown): RandomizeScope | null {
  return typeof value === "string" && (RANDOMIZE_SCOPES as readonly string[]).includes(value) ? (value as RandomizeScope) : null;
}

function asDepth(value: unknown): RandomizeDepth | null {
  return typeof value === "string" && (RANDOMIZE_DEPTHS as readonly string[]).includes(value) ? (value as RandomizeDepth) : null;
}
