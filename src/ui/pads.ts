// Which of the 32 pads is live. Presses and lamps share the row math. A held
// step still owns its page rows for a press. The lamp grid, while the wheel
// is showing randomize, paints that whole face instead, including those rows.

import { PAD_COLUMNS, type ContextId } from "../core/types.ts";
import { auxHidesRandomize, patternPadsVisible, type FaceMode } from "./state.ts";

export const PAD_COUNT = PAD_COLUMNS * 4;

export function padRow(index: number): number {
  return Math.floor(index / PAD_COLUMNS);
}

export function padCol(index: number): number {
  return index % PAD_COLUMNS;
}

/** Page number on the top two rows. The lower two rows are not pages. */
export function gridPage(row: number, column: number): number | null {
  if (row === 3) return column;
  if (row === 2) return PAD_COLUMNS + column;
  return null;
}

export interface PadRead {
  face: FaceMode | null;
  context: ContextId;
  page: number;
  heldContext: ContextId | null;
  heldPage: number | null;
  lanePages: Partial<Record<ContextId, number>> | null;
  wheelTouch: boolean;
  randomizeLatched: boolean;
  sampleHeld: boolean;
  sampleLatched: boolean;
}

export function padRead(source: {
  face?: FaceMode | null;
  context?: ContextId;
  page?: number;
  heldContext?: ContextId | null;
  heldPage?: number | null;
  lanePages?: Partial<Record<ContextId, number>> | null;
  wheelTouch?: boolean;
  randomizeLatched?: boolean;
  sampleHeld?: boolean;
  sampleLatched?: boolean;
}): PadRead {
  return {
    face: source.face ?? null,
    context: source.context ?? "kick",
    page: source.page ?? 0,
    heldContext: source.heldContext ?? null,
    heldPage: source.heldPage ?? null,
    lanePages: source.lanePages ?? null,
    wheelTouch: source.wheelTouch ?? false,
    randomizeLatched: source.randomizeLatched ?? false,
    sampleHeld: source.sampleHeld ?? false,
    sampleLatched: source.sampleLatched ?? false,
  };
}

function wheelShowing(read: PadRead): boolean {
  return read.wheelTouch || read.randomizeLatched;
}

/** Jog touch or a latched click, except on the purple lane and the two faces. */
export function showingRandomize(read: PadRead): boolean {
  return !auxHidesRandomize(read) && wheelShowing(read);
}

/** Lane whose page buttons the randomize face draws, including a held step. */
export function randomizePages(read: PadRead): { context: ContextId; page: number } {
  const held = read.heldContext;
  if (!held) return { context: read.context, page: read.page };
  const remembered = read.heldPage ?? read.lanePages?.[held];
  return { context: held, page: remembered ?? (held === read.context ? read.page : 0) };
}

export type PadGrid = "mixer" | "deck" | "randomize" | "mixed";

/** One picture for the whole grid. Mixed pads are pages, the sample row, or scenes. */
export function padGrid(read: PadRead): PadGrid {
  if (read.face === "mixer") return "mixer";
  if (read.face === "deck") return "deck";
  if (showingRandomize(read)) return "randomize";
  return "mixed";
}

/** Page rows drawn over scenes. Null when the grid is a single face. */
export function litPageRows(read: PadRead): { context: ContextId; page: number; rows: 1 | 2 } | null {
  if (padGrid(read) !== "mixed") return null;
  if (read.heldContext) {
    const place = randomizePages(read);
    return { context: place.context, page: place.page, rows: read.heldContext === "aux" ? 1 : 2 };
  }
  if (read.context === "aux" && wheelShowing(read)) {
    return { context: "aux", page: read.page, rows: 1 };
  }
  return null;
}

export type PadZone =
  | { kind: "mixer"; index: number }
  | { kind: "deck"; index: number }
  | { kind: "page"; page: number; owner: "held" | "aux" }
  | { kind: "randomize"; row: number; column: number }
  | { kind: "sample"; column: number }
  | { kind: "scene"; index: number };

/** What a press on this pad does. */
export function padZone(index: number, read: PadRead): PadZone {
  const row = padRow(index);
  const column = padCol(index);
  if (read.face === "mixer") return { kind: "mixer", index };
  if (read.face === "deck") return { kind: "deck", index };
  const page = gridPage(row, column);
  const held = read.heldContext;
  if (held && page !== null && (held === "aux" ? row === 3 : true)) {
    return { kind: "page", page, owner: "held" };
  }
  if (showingRandomize(read)) return { kind: "randomize", row, column };
  if (!held && read.context === "aux" && wheelShowing(read) && row === 3) {
    return { kind: "page", page: column, owner: "aux" };
  }
  if ((read.sampleHeld || read.sampleLatched) && patternPadsVisible(read) && row === 0) {
    return { kind: "sample", column };
  }
  return { kind: "scene", index };
}
