import type { DeckGroup } from "../core/deck.ts";
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

/** One jog step of the page title. `dir` +1 is the next page, and the line travels left. */
export interface PageTitleSlide {
  from: string;
  dir: -1 | 1;
  startedMs: number;
}

export type RandomizeLine = "depth" | "scope" | "intensity";

/** One randomize row, shown over the lane picture after its pad is pressed. */
export interface RandomizeHint {
  line: RandomizeLine;
  untilMs: number;
}

export type CaptureLine = "transition" | "wander";

/** One Sample row, shown over the lane picture after its pad is pressed. */
export interface CaptureHint {
  line: CaptureLine;
  untilMs: number;
}

/** The macro digit coasting back to zero after its offset was written into the lanes. */
export interface MacroReturn {
  path: string;
  from: number;
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

/** Clicks gathered toward the next value step. A reverse spends this tail first. */
export interface KnobTravel {
  path: string;
  pending: number;
}

/** A pad-taking screen on its own button. Mixer is Mute, DJ FX is Capture. */
export type FaceMode = "mixer" | "deck";

/** Which deck knobs the encoders edit. The tone itself stays in the project. */
export type DeckLayer = "group" | "tone";

/** What a long press of Mute or Capture restores on release. */
export interface FaceReturn {
  latch: FaceMode | null;
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
  /** Jog click leaves the pad menu up after the touch ends. The purple lane keeps the page row. */
  randomizeLatched: boolean;
  /**
   * Latch saved while mixer or DJ FX forces it off. Null while the latch is live.
   * Leaving either face writes this back.
   */
  randomizeParked: boolean | null;
  /** The randomize row last pressed, until its caption times out. */
  randomizeHint: RandomizeHint | null;
  /** The Sample row last pressed, until its caption times out. */
  sampleHint: CaptureHint | null;
  shiftHeld: boolean;
  copyHeld: boolean;
  /** Tick and wall clock when Copy went down, so a short click can paste. */
  copyDownTick: number | null;
  copyDownMs: number | null;
  /** A pad was toggled during this Copy hold, so release must not also paste. */
  copyPicked: boolean;
  /** List from before this Copy press. A short click pastes it; a long press replaces it. */
  copySnapshot: string[] | null;
  /** Journal page. 0 is the newest 32 scenes, newest at the bottom-left pad. */
  journalPage: number;
  deleteHeld: boolean;
  /** Sample strip is under the finger. Transition and wander sit on the bottom row. */
  sampleHeld: boolean;
  /** Strip stays up after a short Sample tap. */
  sampleLatched: boolean;
  /** Latch from before this Sample press, restored when the hold was long. */
  sampleWasLatched: boolean;
  sampleDownTick: number | null;
  sampleDownMs: number | null;
  /**
   * Mixer or DJ FX, shown over the current page. Mute and Capture own these.
   * They are not purple-lane pages: each one takes the pads.
   */
  face: FaceMode | null;
  /** Short press left this mode up after the finger lifted. */
  faceLatch: FaceMode | null;
  /** Mute or Capture is down. The button stays lit for the whole press. */
  faceHeld: FaceMode | null;
  faceDownTick: number | null;
  faceDownMs: number | null;
  /** Latch from before this press. A long release puts it back. */
  faceReturn: FaceReturn | null;
  /** Group currently under a finger. The deck page has to be showing. */
  deckGesture: DeckGroup | null;
  /** Transport tick when that finger went down. The picture counts the gesture from here. */
  deckGestureTick: number | null;
  /** Shift+pad keeps the group after the finger lifts. */
  deckLatchedGesture: DeckGroup | null;
  /** Transport tick when the latch was taken. */
  deckLatchTick: number | null;
  /** How many pad presses have started a deck gesture. The voice uses it as a new entry. */
  deckPress: number;
  /** Bits of deck pads still held. Sound stays until the last one lifts. */
  deckPads: number;
  /** Encoders on the deck. Group is the selected effect; tone is the filter strip. */
  deckLayer: DeckLayer;
  heldContext: ContextId | null;
  heldPage: number | null;
  focus: Focus | null;
  /** Clicks of resistance still owed before leaving the current detent. */
  detent: DetentHold | null;
  /** Partial turn that has not yet completed a value step. */
  travel: KnobTravel | null;
  /** Encoders currently touched, bit 0 is the first knob. */
  heldEncoders: number;
  /** Macro knobs touched or turned since the first finger went down. */
  macroGesture: string[];
  /** Display-only glides back to zero. The project values are already zero. */
  macroReturns: MacroReturn[];
  notice: Notice | null;
  /** Wall-clock end of the page-title overlay. Null when the phrase is uncovered. */
  pageTitleUntilMs: number | null;
  /** Horizontal slide from the page the jog just left. Buttons leave this null. */
  pageTitleSlide: PageTitleSlide | null;
  /** Lane name sits on the line above the page title. Set when the lane changes. */
  pageTitleLane: boolean;
  trackDownTick: (number | null)[];
  trackDownMs: (number | null)[];
  /** Short press that stays on its bookmark until the same button is pressed again. */
  trackLatch: number | null;
  /** Screen from before that short press. The next press of the same button restores it. */
  trackOrigin: TrackPlace | null;
  /** Long hold currently showing its bookmark. Release restores `trackPeekOrigin`. */
  trackPeek: number | null;
  trackPeekOrigin: TrackPlace | null;
}

/** Lane, page, and pad mode (Journal or Set) that a track button can return to. */
export interface TrackPlace {
  context: ContextId;
  page: number;
  mode: UiMode;
}

/** How long a pad step keeps the page title. A jog touch drops the caption with the finger, and a lane button keeps it only while the button is down. */
export const PAGE_TITLE_MS = 500;
/** How long the jog slide takes to bring the new title to center. */
export const PAGE_TITLE_SLIDE_MS = 200;

/** How long a jog release must stay up before the page layer drops. */
export const WHEEL_RELEASE_MS = 80;
/** How long a randomize row stays written over the lane picture. */
export const RANDOMIZE_HINT_MS = 1000;

export const HOLD_TICKS = 80;
/** Wall-clock hold, so a track peek starts while the transport is stopped. */
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

export type PeekKind = "sample";

export interface PeekFlags {
  sampleHeld?: boolean;
  sampleLatched?: boolean;
}

/** Sample is latched. The wander strip is drawn only where pattern pads are showing. */
export function peekKind(ui: PeekFlags): PeekKind | null {
  if (ui.sampleHeld || ui.sampleLatched) return "sample";
  return null;
}

/** Scene pads are on screen. The randomize layer, mixer, and DJ FX hide them. */
export function patternPadsVisible(ui: {
  context?: string | null;
  page?: number;
  heldContext?: string | null;
  heldPage?: number | null;
  lanePages?: Partial<Record<ContextId, number>> | null;
  wheelTouch?: boolean;
  randomizeLatched?: boolean;
  face?: FaceMode | null;
}): boolean {
  if (ui.face === "mixer" || ui.face === "deck") return false;
  const context = (ui.context ?? "kick") as ContextId;
  const onAux = context === "aux" || ui.heldContext === "aux";
  if (!onAux && (ui.wheelTouch || ui.randomizeLatched)) return false;
  return true;
}

/** 300 ms of musical time at the current tempo. */
export function focusHoldTicks(tempo: number): number {
  return Math.max(1, Math.round(0.3 * (Math.max(1, tempo) / 60) * 192));
}

/** Wall-clock linger after an encoder release. The musical clock does not run while stopped. */
export const FOCUS_HOLD_MS = 300;

/** How long a released macro digit takes to reach zero. The lanes already hold the offset. */
export const MACRO_RETURN_MS = 500;

/** Shown macro value while it coasts home. Null once the coast has ended. */
export function macroReturnValue(ret: MacroReturn, now: number): number | null {
  if (now >= ret.untilMs) return null;
  const elapsed = MACRO_RETURN_MS - (ret.untilMs - now);
  const t = Math.min(1, Math.max(0, elapsed / MACRO_RETURN_MS));
  return ret.from * (1 - t);
}

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

/** Mixer and DJ FX take the pads, so the jog latch waits there. */
export function faceHidesRandomize(ui: { face?: FaceMode | null }): boolean {
  return ui.face === "mixer" || ui.face === "deck";
}

/** Purple lane, mixer, and DJ FX do not draw the randomize rows. A held purple step counts. */
export function auxHidesRandomize(ui: { context?: string | null; heldContext?: string | null; face?: FaceMode | null }): boolean {
  return ui.context === "aux" || ui.heldContext === "aux" || faceHidesRandomize(ui);
}

/** Park the jog latch on mixer and DJ FX, and put it back on any other face. */
export function settleRandomize(ui: UiState): UiState {
  if (faceHidesRandomize(ui)) {
    if (ui.randomizeParked !== null) return ui.randomizeLatched ? { ...ui, randomizeLatched: false } : ui;
    return { ...ui, randomizeParked: ui.randomizeLatched, randomizeLatched: false };
  }
  if (ui.randomizeParked === null) return ui;
  return { ...ui, randomizeLatched: ui.randomizeParked, randomizeParked: null };
}

/** Jog click. Mixer and DJ FX flip the parked value and keep their own pads. */
export function toggleRandomize(ui: UiState): UiState {
  const settled = settleRandomize(ui);
  if (settled.randomizeParked !== null) {
    return { ...settled, randomizeParked: !settled.randomizeParked, randomizeLatched: false };
  }
  return { ...settled, randomizeLatched: !settled.randomizeLatched };
}

/** Show the current page name in place. A jog turn replaces this with a slide. */
export function showPageTitle(ui: UiState, now = Date.now()): UiState {
  return { ...ui, pageTitleUntilMs: now + PAGE_TITLE_MS, pageTitleSlide: null };
}

/** Keep `page` and that step's memory on the same clamped index. Leaving DJ FX stops its gesture. */
export function rememberPage(ui: UiState, context: ContextId, page: number): UiState {
  const count = Math.max(1, pageCount(context));
  const clamped = Math.min(Math.max(0, page), count - 1);
  const moved = context !== ui.context || clamped !== ui.page;
  const deckLive = ui.face === "deck";
  const next: UiState = {
    ...ui,
    context,
    page: clamped,
    lanePages: { ...ui.lanePages, [context]: clamped },
    heldPage: ui.heldContext === context ? clamped : ui.heldPage,
    focus: moved ? null : ui.focus,
    detent: moved ? null : ui.detent,
    travel: moved ? null : ui.travel,
    deckGesture: deckLive ? ui.deckGesture : null,
    deckGestureTick: deckLive ? ui.deckGestureTick : null,
    deckLatchedGesture: deckLive ? ui.deckLatchedGesture : null,
    deckLatchTick: deckLive ? ui.deckLatchTick : null,
    deckPads: deckLive ? ui.deckPads : 0,
    pageTitleSlide: null,
  };
  if (!moved) return next;
  return showPageTitle({ ...next, pageTitleLane: ui.heldContext !== null || context !== ui.context });
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
    randomizeParked: null,
    randomizeHint: null,
    sampleHint: null,
    shiftHeld: false,
    copyHeld: false,
    copyDownTick: null,
    copyDownMs: null,
    copyPicked: false,
    copySnapshot: null,
    journalPage: 0,
    deleteHeld: false,
    sampleHeld: false,
    sampleLatched: false,
    sampleWasLatched: false,
    sampleDownTick: null,
    sampleDownMs: null,
    face: null,
    faceLatch: null,
    faceHeld: null,
    faceDownTick: null,
    faceDownMs: null,
    faceReturn: null,
    deckGesture: null,
    deckGestureTick: null,
    deckLatchedGesture: null,
    deckLatchTick: null,
    deckPress: 0,
    deckPads: 0,
    deckLayer: "group",
    heldContext: null,
    heldPage: null,
    focus: null,
    detent: null,
    travel: null,
    heldEncoders: 0,
    macroGesture: [],
    macroReturns: [],
    notice: null,
    pageTitleUntilMs: null,
    pageTitleSlide: null,
    pageTitleLane: false,
    trackDownTick: [null, null, null, null],
    trackDownMs: [null, null, null, null],
    trackLatch: null,
    trackOrigin: null,
    trackPeek: null,
    trackPeekOrigin: null,
  };
}

/** Menus the project file keeps. Mixer and DJ FX share one latch. */
export interface StoredMenus {
  context: ContextId;
  page: number;
  mode: UiMode;
  sampleLatched: boolean;
  randomizeLatched: boolean;
  face: FaceMode | null;
  deckLayer: DeckLayer;
}

/** Put the saved menus back. Mixer and DJ FX park the jog latch until they close. */
export function restoreUi(stored: StoredMenus): UiState {
  return settleRandomize({
    ...rememberPage(defaultUi(), stored.context, stored.page),
    mode: stored.mode,
    sampleLatched: stored.sampleLatched,
    randomizeLatched: stored.randomizeLatched,
    face: stored.face,
    faceLatch: stored.face,
    deckLayer: stored.deckLayer,
  });
}

/** Lane and page on screen. A held step shows its page before the finger lifts. */
export function screenPlace(ui: UiState): TrackPlace {
  const context = ui.heldContext ?? ui.context;
  const page = ui.heldContext ? (ui.heldPage ?? ui.lanePages[ui.heldContext] ?? 0) : ui.page;
  return { context, page, mode: ui.mode };
}

export function openSetMode(ui: UiState): UiState {
  return { ...ui, mode: "set" };
}

/** Drop a latched mixer or deck so the page underneath is visible. A finger still down keeps its peek. */
export function clearFace(ui: UiState): UiState {
  if (ui.faceHeld) return ui;
  if (!ui.face && !ui.faceLatch && !ui.faceReturn) return ui;
  return settleRandomize({
    ...ui,
    face: null,
    faceLatch: null,
    faceHeld: null,
    faceDownTick: null,
    faceDownMs: null,
    faceReturn: null,
    focus: null,
    detent: null,
    travel: null,
    deckGesture: null,
    deckGestureTick: null,
    deckLatchedGesture: null,
    deckLatchTick: null,
    deckPads: 0,
  });
}

export function applyBookmark(ui: UiState, ref: PageRef): UiState {
  return settleRandomize({ ...rememberPage(clearFace(ui), ref.context, ref.page), heldContext: null, heldPage: null });
}

/** Back to the lane, page, and Journal/Set mode from before a track button press. */
export function restoreTrackPlace(ui: UiState, place: TrackPlace): UiState {
  return settleRandomize({
    ...rememberPage(clearFace(ui), place.context, place.page),
    mode: place.mode,
    heldContext: null,
    heldPage: null,
  });
}
