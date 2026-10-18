import { morphProgress } from "../core/morph.ts";
import { sceneColor, journalPadIds, laneHeard, setPadIds } from "../core/performance.ts";
import {
  CAPTURE_DEPTHS,
  CAPTURE_INTENSITIES,
  CAPTURE_SCOPES,
  isDrum,
  isLane,
  LANES,
  STEPS,
  TRANSITIONS,
  WANDERS,
  type ContextId,
  type LaneId,
  type Project,
} from "../core/types.ts";
import { pageCount, pageGroup, pageGroupColor, pagesFor } from "../core/pages.ts";
import { peekKind } from "./state.ts";

export const LED = {
  off: 0,
  red: 127,
  yellow: 8,
  purple: 22,
  lock: 125,
  /** Move RGB palette. Same index Push calls WHITE_MIDI_VALUE. */
  white: 122,
  /** Unsaved working state when journal/set has no scenes yet. */
  working: 8,
} as const;

/** How bright the shared yellow intensity pads read: low, med, high. */
const INTENSITY_SHADE = { soft: 0.2, medium: 0.5, hard: 1 } as const;

export type LedFamily = "red" | "yellow" | "purple" | "lock" | "off";

export interface Led {
  family: LedFamily;
  color: number;
  blink: boolean;
  /** Second phase of a blink. Omitted means off. */
  blinkTo?: number;
}

const COLOR: Record<LedFamily, number> = {
  off: LED.off,
  red: LED.red,
  yellow: LED.yellow,
  purple: LED.purple,
  lock: LED.lock,
};

export function laneFamily(lane: LaneId): "red" | "yellow" {
  return isDrum(lane) ? "red" : "yellow";
}

export function stepLed(project: Project, context: ContextId, lane: LaneId): Led {
  if (!laneHeard(project, lane)) return led("off", false);
  const current = context === lane;
  if (project.lock[lane]) return led("lock", current);
  return led(laneFamily(lane), current);
}

export function auxLed(current: boolean): Led {
  return led("purple", current);
}

export function stepLeds(project: Project, context: ContextId): Led[] {
  const out = STEPS.map((id) => (isLane(id) ? stepLed(project, context, id) : auxLed(context === id)));
  while (out.length < 16) out.push(led("off", false));
  return out;
}

/** Menu is a white button. Lit in Journal, dark in Set. */
export function menuLed(mode: "journal" | "set"): number {
  return mode === "journal" ? PLAY_LED_ON : 0;
}

/** Up is the lower index, down the higher one. Bright only when that neighbor exists. */
export function directionLit(index: number, count: number): { up: number; down: number } {
  return {
    up: index > 0 ? PLAY_LED_ON : 0,
    down: index < count - 1 ? PLAY_LED_ON : 0,
  };
}

/** Bright step of a single-color button. Play cannot take a palette color. */
export const PLAY_LED_ON = 0x7c;

/** Lit while a white-button mode is held or latched. */
export function modeButtonLed(active: boolean): number {
  return active ? PLAY_LED_ON : 0;
}

/** Lit while the transport runs, dark when it is stopped. */
export function playLed(playing: boolean): number {
  return playing ? PLAY_LED_ON : 0;
}

/** A stored bookmark lights its track button in that page's group colour. The one matching the screen blinks. */
export function trackLeds(project: Project, context: ContextId, page: number): Led[] {
  return project.bookmarks.map((ref) => {
    if (!ref) return led("off", false);
    return {
      family: "yellow",
      color: pageGroupColor(ref.context, ref.page),
      blink: ref.context === context && ref.page === page,
    };
  });
}

export interface PadSurface {
  wheelTouch?: boolean;
  captureHeld?: boolean;
  captureLatched?: boolean;
  captureDownMs?: number | null;
  heldContext?: ContextId | null;
  heldPage?: number | null;
  context?: ContextId;
  page?: number;
  lanePages?: Partial<Record<ContextId, number>>;
  copyHeld?: boolean;
  journalPage?: number;
  muteHeld?: boolean;
  muteLatched?: boolean;
  muteDownMs?: number | null;
  muteDownTick?: number | null;
}

/**
 * Playing and morph-target pads share one blink. Target also shades
 * dark→dim→bright by morph progress. An empty journal/set still shows pad 0 as the
 * current working scene. Capture-hold and wheel-touch replace the grid with overlays.
 */
export function padLeds(project: Project, mode: "journal" | "set", surface?: PadSurface, tick = 0): Led[] {
  const context = surface?.context ?? "kick";
  const page = surface?.page ?? 0;
  const kind = peekKind(surface ?? {});
  if (kind === "mute") return mutePeekLeds(project, context);
  if (kind === "capture") return capturePadLeds(project, surface ?? {});
  if (surface?.wheelTouch) return wheelPadLeds(project, context, page);
  const scenes = scenePadLeds(project, mode, tick, surface?.journalPage ?? 0, surface?.copyHeld ?? false);
  if (surface?.heldContext) {
    const shown = surface.heldPage ?? surface.lanePages?.[surface.heldContext] ?? (surface.heldContext === context ? page : -1);
    return pageOverlay(scenes, surface.heldContext, shown);
  }
  return scenes;
}

/** Drums, melody, and lock sit in palette 1–26 so a muted or unlocked pad can dim. */
const PEEK_DRUM = 5;
const PEEK_TONE = 8;
const PEEK_LOCK = 22;
const PEEK_DIM = 0.5;

function mutePeekLeds(project: Project, context: ContextId): Led[] {
  const out = Array.from({ length: 32 }, () => led("off", false));
  LANES.forEach((lane, col) => {
    const active = context === lane;
    const hue = isDrum(lane) ? PEEK_DRUM : PEEK_TONE;
    const muted = shadeColor(hue, project.mute[lane] ? PEEK_DIM : 1);
    const soloed = shadeColor(hue, project.solo[lane] ? 1 : PEEK_DIM);
    const locked = shadeColor(PEEK_LOCK, project.lock[lane] ? 1 : PEEK_DIM);
    out[24 + col] = { family: "yellow", color: muted, blink: active, blinkTo: active ? offColor(hue) : undefined };
    out[16 + col] = { family: "yellow", color: soloed, blink: active, blinkTo: active ? offColor(hue) : undefined };
    out[8 + col] = { family: "purple", color: locked, blink: active, blinkTo: active ? offColor(PEEK_LOCK) : undefined };
  });
  return out;
}

const DEPTH_COLOR = { all: 11, generators: 5, values: 25 } as const;

/** Top two rows are the lane's pages. The next row is depth then scope. The bottom row is intensity. */
function capturePadLeds(project: Project, surface: PadSurface): Led[] {
  const context = surface.heldContext ?? surface.context ?? "kick";
  const rawPage = surface.heldContext ? surface.heldPage ?? surface.page ?? 0 : surface.page ?? 0;
  const page = Math.min(rawPage, Math.max(0, pageCount(context) - 1));
  const out = Array.from({ length: 32 }, () => led("off", false));
  const count = pageCount(context);
  const blinkTo = project.captureIntensity === "clear" ? LED.red : DEPTH_COLOR[project.captureDepth];
  for (let index = 0; index < count; index++) {
    const slot = index < 8 ? 24 + index : 16 + (index - 8);
    if (index >= 16) break;
    const color = pageGroupColor(context, index);
    const hit = captureTouchesPage(project, context, index, page);
    out[slot] = { family: "yellow", color, blink: hit, blinkTo: hit ? blinkTo : undefined };
  }
  CAPTURE_DEPTHS.forEach((id, col) => {
    out[8 + col] = { family: "yellow", color: DEPTH_COLOR[id], blink: project.captureDepth === id };
  });
  CAPTURE_SCOPES.forEach((id, col) => {
    out[12 + col] = { family: "yellow", color: 3, blink: project.captureScope === id };
  });
  CAPTURE_INTENSITIES.forEach((id) => {
    const col = id === "clear" ? 0 : 2 + ["soft", "medium", "hard"].indexOf(id);
    const selected = project.captureIntensity === id;
    if (id === "clear") {
      out[col] = { family: "red", color: LED.red, blink: selected };
      return;
    }
    out[col] = { family: "yellow", color: shadeColor(LED.yellow, INTENSITY_SHADE[id]), blink: selected };
  });
  return out;
}

/** Pages Loop will rewrite. Aux leaves progression, space and global alone. */
function captureTouchesPage(project: Project, context: ContextId, index: number, page: number): boolean {
  const pages = pagesFor(context);
  const item = pages[index];
  if (!item) return false;
  if (context === "aux") {
    const current = pages[page];
    if (!current || current.group !== "macro") return false;
    if (project.captureScope === "page") return index === page;
    return item.group === current.group;
  }
  if (project.captureScope === "lane") return true;
  if (project.captureScope === "page") return index === page;
  const group = pageGroup(context, page);
  const scope = group === "sound" || group === "notes" || group === "fx" ? group : "pattern";
  return item.group === scope;
}

/**
 * Move palette colours 1–26 have dim/dark partners at 63+2c / 64+2c.
 * amount 0 = off; (0,1/3) = dark; [1/3,2/3) = dim; [2/3,1] = bright.
 */
export function shadeColor(color: number, amount: number): number {
  if (amount <= 0) return 0;
  if (color < 1 || color > 26) return amount >= 1 ? color : 0;
  if (amount < 1 / 3) return offColor(color);
  if (amount < 2 / 3) return 63 + 2 * color;
  return color;
}

/** Dark partner of a palette colour: the off version of that hue. */
export function offColor(color: number): number {
  if (color < 1 || color > 26) return LED.off;
  return 64 + 2 * color;
}

/** Pure green. Scene colors never use this index. */
const SELECTED = 126;

function scenePadLeds(project: Project, mode: "journal" | "set", tick: number, journalPage: number, copyHeld: boolean): Led[] {
  const ids = mode === "set" ? setPadIds(project) : journalPadIds(project, journalPage);
  const selected = copyHeld ? new Set(project.clipboardSceneIds) : null;
  if (ids.every((id) => id === null)) {
    return ids.map((_, index) => (index === 0 ? currentSceneLed(LED.working) : led("off", false)));
  }
  const morph = project.morph;
  const targetId = morph?.targetId ?? null;
  const activeId = project.activeSceneId;
  const progress = morph ? morphProgress(morph, tick) : 0;
  // Armed target shows at least dark so the press is visible before the morph starts.
  const targetAmount = morph ? Math.max(progress, 1 / 6) : 0;
  return ids.map((id) => {
    if (!id) return led("off", false);
    const scene = project.journal.find((item) => item.id === id);
    const color = scene?.color ?? sceneColor(id);
    if (selected?.has(id)) return { family: "yellow", color: SELECTED, blink: true, blinkTo: color };
    if (targetId && id === targetId) {
      return { family: "yellow", color: shadeColor(color, targetAmount), blink: true };
    }
    if (id === activeId) return currentSceneLed(color);
    return { family: "yellow", color, blink: false };
  });
}

function wheelPadLeds(project: Project, context: ContextId, page: number): Led[] {
  const out = pageOverlay(Array.from({ length: 32 }, () => led("off", false)), context, page);
  TRANSITIONS.forEach((id, col) => {
    out[col] = { family: "yellow", color: LED.yellow, blink: project.transition === id };
  });
  WANDERS.forEach((id, col) => {
    out[4 + col] = { family: "purple", color: LED.purple, blink: project.wander === id };
  });
  return out;
}

function pageOverlay(base: Led[], context: ContextId, page: number): Led[] {
  const out = base.slice();
  const count = pageCount(context);
  for (let col = 0; col < 8; col++) {
    out[24 + col] = col < count ? pageLed(context, col, col === page) : led("off", false);
    const extra = 8 + col;
    out[16 + col] = extra < count ? pageLed(context, extra, extra === page) : led("off", false);
  }
  return out;
}

/** The playing scene blinks between its colour and white. */
function currentSceneLed(color: number): Led {
  return { family: "yellow", color, blink: true, blinkTo: LED.white };
}

function pageLed(context: ContextId, index: number, current: boolean): Led {
  return { family: "yellow", color: pageGroupColor(context, index), blink: current };
}

/** Half a quarter note at this tempo, in milliseconds. The blink runs on the wall clock. */
export function blinkHalfMs(tempo: number): number {
  return Math.max(1, Math.round(30_000 / Math.max(1, tempo)));
}

export function ledColorAt(led: Led, now: number, tempo: number): number {
  if (!led.blink) return led.color;
  const on = Math.floor(now / blinkHalfMs(tempo)) % 2 === 0;
  return on ? led.color : (led.blinkTo ?? LED.off);
}

function led(family: LedFamily, blink: boolean): Led {
  return { family, color: COLOR[family], blink };
}
