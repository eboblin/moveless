import type { ContextId, LaneId, PageRef } from "../core/types.ts";

export type UiMode = "journal" | "set";

export interface Focus {
  label: string;
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
  mode: UiMode;
  wheelTouch: boolean;
  muteHeld: boolean;
  loopHeld: boolean;
  shiftHeld: boolean;
  copyHeld: boolean;
  deleteHeld: boolean;
  captureHeld: boolean;
  captureGenerator: string | null;
  heldLane: LaneId | null;
  heldPage: number | null;
  focus: Focus | null;
  notice: Notice | null;
  trackDownTick: (number | null)[];
  trackDownMs: (number | null)[];
  laneDownTick: number | null;
}

export const HOLD_TICKS = 80;
/** Wall-clock hold, so a bookmark can be stored while the transport is stopped. */
export const HOLD_MS = 400;

/** 300 ms of musical time at the current tempo. */
export function focusHoldTicks(tempo: number): number {
  return Math.max(1, Math.round(0.3 * (Math.max(1, tempo) / 60) * 192));
}

export function defaultUi(): UiState {
  return {
    context: "kick",
    page: 0,
    mode: "journal",
    wheelTouch: false,
    muteHeld: false,
    loopHeld: false,
    shiftHeld: false,
    copyHeld: false,
    deleteHeld: false,
    captureHeld: false,
    captureGenerator: null,
    heldLane: null,
    heldPage: null,
    focus: null,
    notice: null,
    trackDownTick: [null, null, null, null],
    trackDownMs: [null, null, null, null],
    laneDownTick: null,
  };
}

export function openSetMode(ui: UiState): UiState {
  return { ...ui, mode: "set" };
}

export function openJournalMode(ui: UiState): UiState {
  return { ...ui, mode: "journal" };
}

export function applyBookmark(ui: UiState, ref: PageRef): UiState {
  return { ...ui, context: ref.context, page: ref.page, heldLane: null };
}
