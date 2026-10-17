import { pageCount } from "../core/pages.ts";
import { STEPS, type ContextId, type PageRef } from "../core/types.ts";

export type UiMode = "journal" | "set";

export interface Focus {
  label: string;
  path: string;
  generator: string | null;
  showPattern: boolean;
  held: boolean;
  untilTick: number;
}

export interface Notice {
  title: string;
  value: string;
  untilMs: number;
}

export interface UiState {
  context: ContextId;
  page: number;
  /** Last page of each step. Switching back opens this, not the page you left. */
  lanePages: Record<ContextId, number>;
  mode: UiMode;
  wheelTouch: boolean;
  muteHeld: boolean;
  loopHeld: boolean;
  shiftHeld: boolean;
  copyHeld: boolean;
  deleteHeld: boolean;
  captureHeld: boolean;
  captureGenerator: string | null;
  /** True after a page-pad capture during hold — release must not also group-reroll. */
  captureAction: boolean;
  heldContext: ContextId | null;
  heldPage: number | null;
  focus: Focus | null;
  notice: Notice | null;
  trackDownTick: (number | null)[];
  trackDownMs: (number | null)[];
}

export const HOLD_TICKS = 80;
/** Wall-clock hold, so a bookmark can be stored while the transport is stopped. */
export const HOLD_MS = 400;

/** 300 ms of musical time at the current tempo. */
export function focusHoldTicks(tempo: number): number {
  return Math.max(1, Math.round(0.3 * (Math.max(1, tempo) / 60) * 192));
}

function blankLanePages(): Record<ContextId, number> {
  const pages = {} as Record<ContextId, number>;
  for (const id of STEPS) pages[id] = 0;
  return pages;
}

/** Keep `page` and that step's memory on the same clamped index. */
export function rememberPage(ui: UiState, context: ContextId, page: number): UiState {
  const count = Math.max(1, pageCount(context));
  const clamped = Math.min(Math.max(0, page), count - 1);
  return {
    ...ui,
    context,
    page: clamped,
    lanePages: { ...ui.lanePages, [context]: clamped },
  };
}

export function defaultUi(): UiState {
  return {
    context: "kick",
    page: 0,
    lanePages: blankLanePages(),
    mode: "journal",
    wheelTouch: false,
    muteHeld: false,
    loopHeld: false,
    shiftHeld: false,
    copyHeld: false,
    deleteHeld: false,
    captureHeld: false,
    captureGenerator: null,
    captureAction: false,
    heldContext: null,
    heldPage: null,
    focus: null,
    notice: null,
    trackDownTick: [null, null, null, null],
    trackDownMs: [null, null, null, null],
  };
}

export function openSetMode(ui: UiState): UiState {
  return { ...ui, mode: "set" };
}

export function applyBookmark(ui: UiState, ref: PageRef): UiState {
  return { ...rememberPage(ui, ref.context, ref.page), heldContext: null };
}
