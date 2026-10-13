import { sceneColor, journalPadIds, setPadIds } from "../core/performance.ts";
import { LANE_CODE, type ContextId, type LaneId, type Project, type TransitionId, type WanderId } from "../core/types.ts";
import { pageCount, pageGroupColor } from "./pages.ts";

export const LED = {
  off: 0,
  red: 127,
  yellow: 8,
  purple: 22,
  lock: 125,
} as const;

export type LedFamily = "red" | "yellow" | "purple" | "lock" | "off";

export interface Led {
  family: LedFamily;
  color: number;
  blink: boolean;
}

const COLOR: Record<LedFamily, number> = {
  off: LED.off,
  red: LED.red,
  yellow: LED.yellow,
  purple: LED.purple,
  lock: LED.lock,
};

export function laneFamily(lane: LaneId): "red" | "yellow" {
  return lane === "kick" || lane === "snare" || lane === "hat" || lane === "perc" ? "red" : "yellow";
}

export function stepLed(project: Project, context: ContextId, lane: LaneId): Led {
  const current = context === lane;
  const locked = project.lock[lane];
  const muted = project.mute[lane];
  if (current && locked) return led("lock", true);
  if (current) return led(laneFamily(lane), true);
  if (muted && locked) return led("lock", false);
  if (muted) return led("off", false);
  if (locked) return led("lock", false);
  return led(laneFamily(lane), false);
}

export function auxLed(current: boolean): Led {
  return led("purple", current);
}

export function stepLeds(project: Project, context: ContextId): Led[] {
  const lanes: LaneId[] = ["kick", "snare", "hat", "perc", "bass", "lead", "chords"];
  const out = lanes.map((lane) => stepLed(project, context, lane));
  out.push(auxLed(context === "mix"));
  out.push(auxLed(context === "global"));
  while (out.length < 16) out.push(led("off", false));
  return out;
}

export function menuLed(mode: "journal" | "set"): Led {
  return led(mode === "set" ? "purple" : "yellow", false);
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

const TRANSITIONS: TransitionId[] = ["now", "fast", "medium", "slow"];
const WANDERS: WanderId[] = ["fast", "medium", "slow", "glacial"];
export interface PadSurface {
  wheelTouch?: boolean;
  heldLane?: LaneId | null;
  context?: ContextId;
  page?: number;
}

/** Occupied scene pads use that scene's color. The newest one blinks. Wheel-touch replaces the grid with pages, Transition and Wander. */
export function padLeds(project: Project, mode: "journal" | "set", surface?: PadSurface): Led[] {
  const context = surface?.context ?? "kick";
  const page = surface?.page ?? 0;
  if (surface?.wheelTouch) return wheelPadLeds(project, context, page);
  const scenes = scenePadLeds(project, mode);
  if (surface?.heldLane) return pageOverlay(scenes, surface.heldLane, surface.heldLane === context ? page : -1);
  return scenes;
}

function scenePadLeds(project: Project, mode: "journal" | "set"): Led[] {
  const ids = mode === "set" ? setPadIds(project) : journalPadIds(project);
  let newest = -1;
  ids.forEach((id, index) => {
    if (id) newest = index;
  });
  return ids.map((id, index) => {
    if (!id) return led("off", false);
    const scene = project.journal.find((item) => item.id === id);
    return { family: "yellow", color: scene?.color ?? sceneColor(id), blink: index === newest };
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

function pageLed(context: ContextId, index: number, current: boolean): Led {
  return { family: "yellow", color: pageGroupColor(context, index), blink: current };
}

export const MENU_CC = 50;

export function ledLabel(project: Project, context: ContextId): string {
  return LANE_CODE[context];
}

function led(family: LedFamily, blink: boolean): Led {
  return { family, color: COLOR[family], blink };
}
