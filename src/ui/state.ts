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
  /** Wall-clock end of the post-release preview. Musical ticks stop when transport does. */
  untilMs: number;
}

export interface Notice {
  title: string;
  value: string;
  untilMs: number;
}

export type RandomizeLine = "depth" | "scope" | "intensity";

/** One randomize row, shown over the lane picture after its pad is pressed. */
export interface RandomizeHint {
  line: RandomizeLine;
  untilMs: number;
}

export type CaptureLine = "transition" | "wander";

/** One Capture row, shown over the lane picture after its pad is pressed. */
export interface CaptureHint {
  line: CaptureLine;
  untilMs: number;
}

export interface DetentHold {
  path: string;
  dir: -1 | 1;
  /** Clicks still to spend before this direction leaves the detent. */
  left: number;
  /** Wall-clock time of the last turn that stayed on this detent. */
  since: number;
}

export interface UiState {
  context: ContextId;
  page: number;
  /** Last page of each step. Switching back opens this, not the page you left. */
  lanePages: Record<ContextId, number>;
  mode: UiMode;
  wheelTouch: boolean;
  /** Release is pending until this time, so a contact bounce does not drop the wheel layer. */
  wheelReleaseMs: number | null;
  /** Jog click leaves the randomize pads up after the touch ends. */
  randomizeLatched: boolean;
  /** The randomize row last pressed, until its caption times out. */
  randomizeHint: RandomizeHint | null;
  /** The Capture row last pressed, until its caption times out. */
  captureHint: CaptureHint | null;
  muteHeld: boolean;
  /** Peek stays up after a short Mute tap. */
  muteLatched: boolean;
  /** Latch from before this Mute press, restored when the hold was long. */
  muteWasLatched: boolean;
  /** Tick and wall clock when Mute went down. */
  muteDownTick: number | null;
  muteDownMs: number | null;
  shiftHeld: boolean;
  copyHeld: boolean;
  /** Tick and wall clock when Copy went down, so a short click can paste. */
  copyDownTick: number | null;
  copyDownMs: number | null;
  /** A pad was toggled during this Copy hold, so release must not also paste. */
  copyPicked: boolean;
  /** List from before this Copy press. A short click pastes it; a long press replaces it. */
  copySnapshot: string[] | null;
  /** Journal page. 0 is the newest 32 scenes. */
  journalPage: number;
  deleteHeld: boolean;
  captureHeld: boolean;
  /** Peek stays up after a short Capture tap. */
  captureLatched: boolean;
  /** Latch from before this Capture press, restored when the hold was long. */
  captureWasLatched: boolean;
  captureDownTick: number | null;
  captureDownMs: number | null;
  heldContext: ContextId | null;
  heldPage: number | null;
  focus: Focus | null;
  /** Clicks of resistance still owed before leaving the current detent. */
  detent: DetentHold | null;
  notice: Notice | null;
  trackDownTick: (number | null)[];
  trackDownMs: (number | null)[];
}

/** How long a jog release must stay up before the page layer drops. */
export const WHEEL_RELEASE_MS = 80;
/** How long a randomize row stays written over the lane picture. */
export const RANDOMIZE_HINT_MS = 1000;

export const HOLD_TICKS = 80;
/** Wall-clock hold, so a bookmark can be stored while the transport is stopped. */
export const HOLD_MS = 400;

/** Drop the jog layer once a release has stayed up through the bounce window. */
export function settleWheel(ui: UiState, now = Date.now()): UiState {
  if (ui.wheelReleaseMs === null) return ui;
  if (now - ui.wheelReleaseMs < WHEEL_RELEASE_MS) return ui;
  return { ...ui, wheelTouch: false, wheelReleaseMs: null };
}

/** A tap under either threshold. A stopped clock still counts as short via the wall clock. */
export function holdIsShort(downTick: number | null, downMs: number | null, tick: number, now = Date.now()): boolean {
  const heldTicks = downTick === null ? 0 : tick - downTick;
  const heldMs = downMs === null ? 0 : now - downMs;
  return heldTicks < HOLD_TICKS && heldMs < HOLD_MS;
}

export type PeekKind = "mute" | "capture";

export interface PeekFlags {
  muteHeld?: boolean;
  muteLatched?: boolean;
  muteDownMs?: number | null;
  captureHeld?: boolean;
  captureLatched?: boolean;
  captureDownMs?: number | null;
}

/** The peek on screen. A held button beats the other button's latch. */
export function peekKind(ui: PeekFlags): PeekKind | null {
  const captureHeld = ui.captureHeld ?? false;
  const muteHeld = ui.muteHeld ?? false;
  if (captureHeld && muteHeld) {
    return (ui.captureDownMs ?? 0) >= (ui.muteDownMs ?? 0) ? "capture" : "mute";
  }
  if (captureHeld) return "capture";
  if (muteHeld) return "mute";
  if (ui.captureLatched) return "capture";
  if (ui.muteLatched) return "mute";
  return null;
}

export function mutePeekOpen(ui: PeekFlags): boolean {
  return peekKind(ui) === "mute";
}

/** 300 ms of musical time at the current tempo. */
export function focusHoldTicks(tempo: number): number {
  return Math.max(1, Math.round(0.3 * (Math.max(1, tempo) / 60) * 192));
}

/** Wall-clock linger after an encoder release. The musical clock does not run while stopped. */
export const FOCUS_HOLD_MS = 300;

/** Knob preview: while the encoder is down, then until both the musical and wall clocks expire. */
export function focusVisible(focus: Focus | null, tick: number, now: number): boolean {
  if (!focus) return false;
  return focus.held || (tick < focus.untilTick && now < focus.untilMs);
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
  const moved = context !== ui.context || clamped !== ui.page;
  return {
    ...ui,
    context,
    page: clamped,
    lanePages: { ...ui.lanePages, [context]: clamped },
    focus: moved ? null : ui.focus,
    detent: moved ? null : ui.detent,
  };
}

export function defaultUi(): UiState {
  return {
    context: "kick",
    page: 0,
    lanePages: blankLanePages(),
    mode: "journal",
    wheelTouch: false,
    wheelReleaseMs: null,
    randomizeLatched: false,
    randomizeHint: null,
    captureHint: null,
    muteHeld: false,
    muteLatched: false,
    muteWasLatched: false,
    muteDownTick: null,
    muteDownMs: null,
    shiftHeld: false,
    copyHeld: false,
    copyDownTick: null,
    copyDownMs: null,
    copyPicked: false,
    copySnapshot: null,
    journalPage: 0,
    deleteHeld: false,
    captureHeld: false,
    captureLatched: false,
    captureWasLatched: false,
    captureDownTick: null,
    captureDownMs: null,
    heldContext: null,
    heldPage: null,
    focus: null,
    detent: null,
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
