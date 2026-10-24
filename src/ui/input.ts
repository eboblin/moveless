import {
  randomizeLane,
  randomizePaths,
  commitMacro,
  randomizeSurface,
  clampJournalPage,
  cycleSet,
  deleteSet,
  resetLane,
  launchScene,
  pasteClipboard,
  recordInto,
  toggleClipboard,
  removeSceneFromJournal,
  removeSceneFromSet,
  journalPadIds,
  setRandomizeDepth,
  setRandomizeIntensity,
  setRandomizeScope,
  setPadIds,
  setWander,
  toggleSolo,
  toggleLock,
  toggleMute,
} from "../core/performance.ts";
import { DECK_GROUPS, fieldAt, focusedGroup, groupAt, recallGroup, setGroupCell, type DeckGroup } from "../core/deck.ts";
import { CAPTURE_CC, contextAtStep, DOWN_CC, isLane, JOG_CLICK_CC, LANES, LOOP_CC, MENU_CC, PLAY_CC, RANDOMIZE_DEPTHS, RANDOMIZE_SCOPES, RECORD_CC, TRANSITIONS, UP_CC, WANDERS, type ContextId, type PatternId, type Project } from "../core/types.ts";
import { resetControl, writeControl } from "./controls.ts";
import { bindingFor, bindingPaths, deckPage, livePage, pageCount, pageGroup, pageId, pageTitle, pagesFor, scopeIncludesPage } from "../core/pages.ts";
import { applyBookmark, auxHidesRandomize, FOCUS_HOLD_MS, focusHoldTicks, HOLD_MS, HOLD_TICKS, holdIsShort, MACRO_RETURN_MS, PAGE_TITLE_MS, patternPadsVisible, RANDOMIZE_HINT_MS, rememberPage, restoreTrackPlace, screenPlace, settleRandomize, settleWheel, showPageTitle, toggleRandomize, type CaptureLine, type MacroReturn, type Notice, type RandomizeLine, type UiState } from "./state.ts";
import { journalPageCount } from "../core/journal.ts";

export interface MidiMsg {
  kind: "note" | "cc";
  data1: number;
  data2: number;
}

export interface Session {
  project: Project;
  ui: UiState;
  tick: number;
  playing: boolean;
}

const SHIFT = 49;

/**
 * Notes and control changes only. Pad pressure is polyphonic aftertouch on the
 * same note number, and the second pad row shares numbers with Mute, Play and
 * Record. Reading that pressure as a CC would steal the pad.
 */
export function midiMessage(status: number, data1: number, data2: number): MidiMsg | null {
  const hi = status & 0xf0;
  if (hi === 0x80) return { kind: "note", data1, data2: 0 };
  if (hi === 0x90) return { kind: "note", data1, data2 };
  if (hi === 0xb0) return { kind: "cc", data1, data2 };
  return null;
}

export function reduce(session: Session, msg: MidiMsg): Session {
  session = { ...session, ui: settleWheel(session.ui) };
  session = settleTrackPeek(session);
  const press = msg.data2 > 0;
  if (msg.kind === "note") return onNote(session, msg.data1, press);
  return onCc(session, msg.data1, msg.data2, press);
}

function onNote(session: Session, note: number, press: boolean): Session {
  if (note >= 0 && note <= 7) return touchEncoder(session, note, press);
  if (note === 9) return touchWheel(session, press);
  if (note >= 16 && note <= 31) return onStep(session, note - 16, press);
  if (note >= 68 && note <= 99) return onPad(session, note - 68, press);
  return session;
}

function onCc(session: Session, cc: number, value: number, press: boolean): Session {
  if (cc === SHIFT) return { ...session, ui: { ...session.ui, shiftHeld: press } };
  if (cc === MENU_CC && press) {
    const mode = session.ui.mode === "set" ? "journal" : "set";
    return {
      ...session,
      ui: { ...session.ui, mode, notice: modeNotice("MODE", mode === "set" ? "SET" : "JOURNAL") },
    };
  }
  if (cc === 60) return onCopy(session, press);
  if (cc === 119) return { ...session, ui: { ...session.ui, deleteHeld: press } };
  if (cc === CAPTURE_CC) return onCapture(session, press);
  if (cc === JOG_CLICK_CC && press) {
    return { ...session, ui: toggleRandomize(session.ui) };
  }
  if (cc === LOOP_CC && press) return applyRandomize(session);
  if (cc === RECORD_CC && press) return { ...session, project: recordInto(session.project, session.ui.mode === "set") };
  if (cc === PLAY_CC && press) return { ...session, playing: !session.playing };
  if (cc >= 71 && cc <= 78) return turnEncoder(session, cc - 71, value);
  if (cc === 14) return turnWheel(session, value);
  if (cc >= 40 && cc <= 43) return onTrack(session, cc - 40, press);
  if ((cc === DOWN_CC || cc === UP_CC) && press) return onArrow(session, cc === UP_CC ? -1 : 1);
  return session;
}

function onStep(session: Session, index: number, press: boolean): Session {
  const step = contextAtStep(index);
  if (!step) return session;
  if (isLane(step)) {
    if (session.ui.deleteHeld && press) {
      return {
        ...session,
        project: resetLane(session.project, step),
        ui: showPageTitle({ ...session.ui, heldContext: step, focus: null, pageTitleLane: step !== session.ui.context }),
      };
    }
  }
  if (!press) {
    if (session.ui.heldContext !== step) return session;
    const page = session.ui.heldPage ?? session.ui.lanePages[step] ?? 0;
    const placed = rememberPage(session.ui, step, page);
    return {
      ...session,
      ui: settleRandomize({ ...placed, heldContext: null, heldPage: null, pageTitleUntilMs: null }),
    };
  }
  return {
    ...session,
    ui: showPageTitle(
      settleRandomize({
        ...session.ui,
        heldContext: step,
        focus: step === session.ui.context ? session.ui.focus : null,
        pageTitleLane: step !== session.ui.context,
      }),
    ),
  };
}

function onPad(session: Session, index: number, press: boolean): Session {
  if (!press) return onPadRelease(session, index);
  const row = Math.floor(index / 8);
  const col = index % 8;
  const top = row === 3;
  const second = row === 2;
  const randomize = !auxHidesRandomize(session.ui) && (session.ui.wheelTouch || session.ui.randomizeLatched);
  if (randomize) return onRandomizePad(session, row, col);
  const holdingAux = session.ui.heldContext === "aux";
  if (!session.ui.heldContext && session.ui.context === "aux" && session.ui.wheelTouch && top) {
    if (col >= pageCount("aux")) return session;
    return { ...session, ui: settleRandomize(rememberPage(session.ui, "aux", col)) };
  }
  if (session.ui.heldContext && (holdingAux ? top : top || second)) {
    const page = top ? col : 8 + col;
    const held = session.ui.heldContext;
    if (page >= pageCount(held)) return session;
    return {
      ...session,
      ui: settleRandomize({ ...rememberPage(session.ui, held, page), heldContext: held, heldPage: page }),
    };
  }
  if (facePageId(session.ui) === "mixer") return onMutePad(session, index);
  if (facePageId(session.ui) === "deck") return pressDeckPad(session, index);
  if ((session.ui.captureHeld || session.ui.captureLatched) && patternPadsVisible(session.ui)) {
    if (row === 0) return onCaptureStrip(session, col);
    return onScenePad(session, index - 8);
  }
  return onScenePad(session, index);
}

/** Page whose pads are live. A held purple step uses the page under the finger, before release. */
function facePageId(ui: UiState): string | null {
  if (ui.heldContext === "aux") {
    const index = ui.heldPage ?? ui.lanePages.aux ?? (ui.context === "aux" ? ui.page : 0);
    return pageId("aux", index);
  }
  return pageId(ui.context, ui.page);
}

function onPadRelease(session: Session, index: number): Session {
  if (facePageId(session.ui) !== "deck") return session;
  return releaseDeckPad(session, index);
}

function releaseDeckPad(session: Session, index: number): Session {
  if ((session.ui.deckPads & (1 << index)) === 0) return session;
  const deckPads = session.ui.deckPads & ~(1 << index);
  if (deckPads !== 0 || session.ui.deckLatchedGesture) {
    return { ...session, ui: { ...session.ui, deckPads } };
  }
  return { ...session, ui: { ...session.ui, deckPads: 0, deckGesture: null, deckGestureTick: null } };
}

function pressDeckPad(session: Session, index: number): Session {
  const group = groupAt(index);
  const field = fieldAt(index);
  if (!group && !field) return session;
  const which: DeckGroup = group ?? DECK_GROUPS[session.project.deck.focus] ?? "rpt";
  const bar = session.project.global.bar;
  const deck = field
    ? setGroupCell(session.project.deck, which, field.x, field.y, bar)
    : recallGroup(session.project.deck, which, bar);
  const deckPads = session.ui.deckPads | (1 << index);
  const deckPress = session.ui.deckPress + 1;
  if (session.ui.shiftHeld) {
    const latched = session.ui.deckLatchedGesture === which ? null : which;
    return {
      ...session,
      project: { ...session.project, deck },
      ui: {
        ...session.ui,
        deckLatchedGesture: latched,
        deckLatchTick: latched ? session.tick : null,
        deckGesture: null,
        deckGestureTick: null,
        deckPress,
        deckPads,
      },
    };
  }
  return {
    ...session,
    project: { ...session.project, deck },
    ui: {
      ...session.ui,
      deckGesture: which,
      deckGestureTick: session.tick,
      deckPress,
      deckPads,
    },
  };
}

/** Patterns of the journal or the active set. */
function onScenePad(session: Session, index: number): Session {
  const pads = session.ui.mode === "set"
    ? setPadIds(session.project)
    : journalPadIds(session.project, session.ui.journalPage);
  if (session.ui.deleteHeld) {
    const id = pads[index];
    if (!id) return session;
    if (session.ui.mode === "set") {
      if (!session.project.activeSetId) return session;
      return { ...session, project: removeSceneFromSet(session.project, session.project.activeSetId, id) };
    }
    const project = removeSceneFromJournal(session.project, id);
    return { ...session, project, ui: { ...session.ui, journalPage: clampJournalPage(session.ui.journalPage, project.journal.length) } };
  }
  if (session.ui.copyHeld) {
    const id = pads[index];
    if (!id) return session;
    return {
      ...session,
      project: toggleClipboard(session.project, id),
      ui: { ...session.ui, copyPicked: true },
    };
  }
  const sceneId = pads[index];
  if (!sceneId) return session;
  return { ...session, project: launchScene(session.project, sceneId, session.tick) };
}

/** Wander and transition on the bottom row. Pattern pads above are the row that used to sit under them. */
function onCaptureStrip(session: Session, col: number): Session {
  if (col < TRANSITIONS.length) {
    const transition = TRANSITIONS[col];
    return showCaptureLine(session, { ...session.project, transition }, "transition");
  }
  if (col === 4) return showCaptureLine(session, setWander(session.project, null, session.tick), "wander");
  if (col >= 5 && col < 5 + WANDERS.length) {
    return showCaptureLine(session, setWander(session.project, WANDERS[col - 5], session.tick), "wander");
  }
  return session;
}

/** Randomize overlay. Top two rows pick a page. The next row is depth, then scope. The bottom row is intensity. */
function onRandomizePad(session: Session, row: number, col: number): Session {
  if (row === 3 || row === 2) {
    const page = row === 3 ? col : 8 + col;
    return selectPage(session, page);
  }
  if (row === 1 && col < RANDOMIZE_DEPTHS.length) {
    return showRandomizeLine(session, setRandomizeDepth(session.project, RANDOMIZE_DEPTHS[col]), "depth");
  }
  if (row === 1 && col >= 4 && col < 4 + RANDOMIZE_SCOPES.length) {
    return showRandomizeLine(session, setRandomizeScope(session.project, RANDOMIZE_SCOPES[col - 4]), "scope");
  }
  if (row === 0 && col === 0) return showRandomizeLine(session, setRandomizeIntensity(session.project, "clear"), "intensity");
  if (row === 0 && col >= 1 && col <= 3) {
    const level = (["soft", "medium", "hard"] as const)[col - 1];
    return showRandomizeLine(session, setRandomizeIntensity(session.project, level), "intensity");
  }
  return session;
}

function showRandomizeLine(session: Session, project: Project, line: RandomizeLine): Session {
  return {
    ...session,
    project,
    ui: { ...session.ui, randomizeHint: { line, untilMs: Date.now() + RANDOMIZE_HINT_MS } },
  };
}

function showCaptureLine(session: Session, project: Project, line: CaptureLine): Session {
  return {
    ...session,
    project,
    ui: { ...session.ui, captureHint: { line, untilMs: Date.now() + RANDOMIZE_HINT_MS } },
  };
}

const NOTICE_MS = 500;

function modeNotice(title: string, value: string): Notice {
  return { title, value, untilMs: Date.now() + NOTICE_MS };
}

function selectPage(session: Session, page: number): Session {
  if (page >= pageCount(session.ui.context)) return session;
  return { ...session, ui: rememberPage(session.ui, session.ui.context, page) };
}

/** Touch shows the page layer at once. Release waits out contact bounce before the layer drops. */
function touchWheel(session: Session, press: boolean): Session {
  if (press) {
    if (session.ui.wheelTouch && session.ui.wheelReleaseMs === null) return session;
    const fresh = !session.ui.wheelTouch;
    return {
      ...session,
      ui: {
        ...session.ui,
        wheelTouch: true,
        wheelReleaseMs: null,
        pageTitleUntilMs: Date.now() + PAGE_TITLE_MS,
        ...(fresh ? { pageTitleSlide: null, pageTitleLane: false } : {}),
      },
    };
  }
  if (!session.ui.wheelTouch || session.ui.wheelReleaseMs !== null) return session;
  return {
    ...session,
    ui: {
      ...session.ui,
      wheelReleaseMs: Date.now(),
      ...(session.ui.heldContext ? {} : { pageTitleUntilMs: null, pageTitleSlide: null }),
    },
  };
}

function turnWheel(session: Session, value: number): Session {
  const delta = relDelta(value);
  if (!delta) return session;
  const count = pageCount(session.ui.context);
  let page = session.ui.page + (delta > 0 ? 1 : -1);
  if (page < 0) page = 0;
  if (page >= count) page = count - 1;
  if (page === session.ui.page) return session;
  const place = screenPlace(session.ui);
  const from = pageTitle(session.project, place.context, place.page);
  const ui = rememberPage(session.ui, session.ui.context, page);
  return {
    ...session,
    ui: {
      ...ui,
      pageTitleUntilMs: Date.now() + PAGE_TITLE_MS,
      pageTitleSlide: { from, dir: delta > 0 ? 1 : -1, startedMs: Date.now() },
      pageTitleLane: false,
    },
  };
}

function touchEncoder(session: Session, index: number, press: boolean): Session {
  const bit = 1 << index;
  if (!press) {
    if ((session.ui.heldEncoders & bit) === 0) return session;
    const heldEncoders = session.ui.heldEncoders & ~bit;
    const focus = session.ui.focus;
    if (heldEncoders !== 0) {
      return { ...session, ui: { ...session.ui, heldEncoders, focus: focus ? { ...focus, held: true } : focus } };
    }
    let project = session.project;
    const macroReturns: MacroReturn[] = [];
    const untilMs = Date.now() + MACRO_RETURN_MS;
    for (const path of session.ui.macroGesture) {
      const binding = bindingFor(path);
      if (binding?.store !== "macro") continue;
      const from = project.macros[path.slice("macro.".length)] ?? 0;
      if (from === 0) continue;
      project = commitMacro(project, path.slice("macro.".length));
      macroReturns.push({ path, from, untilMs });
    }
    return {
      ...session,
      project,
      ui: {
        ...session.ui,
        heldEncoders: 0,
        macroGesture: [],
        macroReturns,
        focus: focus
          ? {
              ...focus,
              held: false,
              untilTick: session.tick + focusHoldTicks(project.global.tempo),
              untilMs: Date.now() + FOCUS_HOLD_MS,
            }
          : focus,
      },
    };
  }
  const binding = currentBinding(session, index);
  if (!binding) return session;
  const sameKnob = session.ui.detent?.path === binding.path;
  const ui = {
    ...session.ui,
    heldEncoders: session.ui.heldEncoders | bit,
    macroGesture: rememberMacro(session.ui.macroGesture, binding),
    macroReturns: [],
    focus: focusFor(session, binding, true),
    detent: session.ui.shiftHeld || !sameKnob ? null : session.ui.detent,
  };
  if (!session.ui.shiftHeld) return { ...session, ui };
  return { ...session, project: resetControl(session.project, session.ui.context, binding), ui };
}

function turnEncoder(session: Session, index: number, value: number): Session {
  const delta = relDelta(value);
  const binding = currentBinding(session, index);
  if (!binding || !delta) return session;
  const fingers = session.ui.heldEncoders !== 0;
  const coasting = session.ui.macroReturns.some((item) => item.path === binding.path);
  const turned = writeControl(session.project, session.ui.context, binding, delta, session.ui.detent);
  return {
    ...session,
    project: turned.project,
    ui: {
      ...session.ui,
      macroGesture: fingers ? rememberMacro(session.ui.macroGesture, binding) : session.ui.macroGesture,
      macroReturns: coasting ? session.ui.macroReturns.filter((item) => item.path !== binding.path) : session.ui.macroReturns,
      detent: turned.hold,
      focus: focusFor(session, binding, fingers || (session.ui.focus?.held ?? false)),
    },
  };
}

function rememberMacro(gesture: readonly string[], binding: { path: string; store: string }): string[] {
  if (binding.store !== "macro" || gesture.includes(binding.path)) return gesture.slice();
  return [...gesture, binding.path];
}

function focusFor(session: Session, binding: { path: string; label: string }, held: boolean) {
  return {
    path: binding.path,
    label: binding.label,
    generator: modulatedBase(binding.path),
    showPattern: binding.path.endsWith(".pattern"),
    held,
    untilTick: session.tick + focusHoldTicks(session.project.global.tempo),
    untilMs: Date.now() + FOCUS_HOLD_MS,
  };
}

export function modulatedBase(path: string): string | null {
  const suffixes = [".value", ".pattern", ".cycle", ".amount"];
  const suffix = suffixes.find((item) => path.endsWith(item));
  return suffix ? path.slice(0, -suffix.length) : null;
}

function currentBinding(session: Session, index: number) {
  const page = livePage(session.project, session.ui.context, session.ui.page);
  return page?.bindings[index] ?? null;
}

/** Top row toggles mute, the next solos, the next locks. Fx takes the eighth column: mute and lock, no solo. */
function onMutePad(session: Session, index: number): Session {
  const row = Math.floor(index / 8);
  const col = index % 8;
  if (col === LANES.length) {
    if (row === 3) return { ...session, project: toggleMute(session.project, "fx") };
    if (row === 1) return { ...session, project: toggleLock(session.project, "fx") };
    return session;
  }
  const lane = LANES[col];
  if (!lane) return session;
  if (row === 3) return { ...session, project: toggleMute(session.project, lane) };
  if (row === 2) return { ...session, project: toggleSolo(session.project, lane) };
  if (row === 1) return { ...session, project: toggleLock(session.project, lane) };
  return session;
}

function onCapture(session: Session, press: boolean): Session {
  if (press) {
    return {
      ...session,
      ui: {
        ...session.ui,
        captureHeld: true,
        captureWasLatched: session.ui.captureLatched,
        captureDownTick: session.tick,
        captureDownMs: Date.now(),
      },
    };
  }
  const short = holdIsShort(session.ui.captureDownTick, session.ui.captureDownMs, session.tick);
  const latched = short ? !session.ui.captureWasLatched : session.ui.captureWasLatched;
  return {
    ...session,
    ui: {
      ...session.ui,
      captureHeld: false,
      captureLatched: latched,
      captureDownTick: null,
      captureDownMs: null,
    },
  };
}

/** One randomize pass. Loop runs this from any screen and leaves the peek where it is. */
function applyRandomize(session: Session): Session {
  const { context, page } = randomizeTarget(session);
  let project = session.project;
  if (context === "aux") project = rerollAux(project, page);
  else if (isLane(context)) project = rerollLane(project, context, page);
  return { ...session, project };
}

function randomizeTarget(session: Session): { context: ContextId; page: number } {
  const context = session.ui.heldContext ?? session.ui.context;
  const rawPage = session.ui.heldContext ? session.ui.heldPage ?? session.ui.page : session.ui.page;
  const page = Math.min(rawPage, Math.max(0, pageCount(context) - 1));
  return { context, page };
}

/** One budget per aux page. Each store keeps its own home. DJ FX uses the focused group's knobs. */
function rerollAux(project: Project, page: number): Project {
  let next = project;
  pagesFor("aux").forEach((item, index) => {
    if (!scopeIncludesPage(next.randomizeScope, "aux", index, page)) return;
    const live = item.id === "deck" ? deckPage(focusedGroup(next.deck), next.deck) : item;
    const paths = bindingPaths(live);
    const store = live.bindings.find((binding) => binding)?.store;
    if (store === "progression" || store === "global" || store === "bus") next = randomizeSurface(next, store, paths);
    else if (store === "macro") next = randomizeSurface(next, "perf", paths);
    else if (store === "mixer") next = randomizeSurface(next, "mix", paths);
    else if (store === "deck") next = randomizeSurface(next, "deck", paths);
  });
  return next;
}

function rerollLane(project: Project, lane: PatternId, page: number): Project {
  if (project.randomizeScope === "lane") return randomizeLane(project, lane, "all");
  if (project.randomizeScope === "page") {
    const pages = pagesFor(lane);
    const current = pages[Math.min(page, Math.max(0, pages.length - 1))];
    return randomizePaths(project, lane, current ? bindingPaths(current) : []);
  }
  const scope = pageGroup(lane, page);
  const group = scope === "sound" || scope === "notes" || scope === "fx" ? scope : "pattern";
  return randomizeLane(project, lane, group);
}

function onArrow(session: Session, direction: -1 | 1): Session {
  if (session.ui.mode === "set") {
    if (direction > 0 && session.ui.deleteHeld) return deleteActiveSet(session);
    return { ...session, project: cycleSet(session.project, direction) };
  }
  const count = journalPageCount(session.project.journal.length);
  const page = Math.max(0, Math.min(count - 1, session.ui.journalPage + direction));
  return { ...session, ui: { ...session.ui, journalPage: page } };
}

function onCopy(session: Session, press: boolean): Session {
  if (press) {
    return {
      ...session,
      project: { ...session.project, clipboardSceneIds: [] },
      ui: {
        ...session.ui,
        copyHeld: true,
        copyDownTick: session.tick,
        copyDownMs: Date.now(),
        copyPicked: false,
        copySnapshot: session.project.clipboardSceneIds,
      },
    };
  }
  const heldTicks = session.ui.copyDownTick === null ? 0 : session.tick - session.ui.copyDownTick;
  const heldMs = session.ui.copyDownMs === null ? 0 : Date.now() - session.ui.copyDownMs;
  const short = heldTicks < HOLD_TICKS && heldMs < HOLD_MS;
  const selecting = !short || session.ui.copyPicked;
  let project = session.project;
  if (!selecting) {
    project = { ...project, clipboardSceneIds: session.ui.copySnapshot ?? [] };
    if (session.ui.mode === "set") project = pasteClipboard(project);
  }
  return {
    ...session,
    project,
    ui: { ...session.ui, copyHeld: false, copyDownTick: null, copyDownMs: null, copyPicked: false, copySnapshot: null },
  };
}

/** Delete clears the stored page. The screen stays where it is. */
function clearBookmark(session: Session, index: number): Session {
  const bookmarks = session.project.bookmarks.slice();
  bookmarks[index] = null;
  let ui = session.ui;
  if (ui.trackLatch === index) ui = { ...ui, trackLatch: null, trackOrigin: null };
  return { ...session, project: { ...session.project, bookmarks }, ui };
}

/** Shift stores the screen that is showing, including a purple-lane page under a held step. */
function storeBookmark(session: Session, index: number): Session {
  const place = screenPlace(session.ui);
  const count = Math.max(1, pageCount(place.context));
  const bookmarks = session.project.bookmarks.slice();
  bookmarks[index] = { context: place.context, page: Math.min(Math.max(0, place.page), count - 1) };
  return { ...session, project: { ...session.project, bookmarks } };
}

/**
 * A long hold opens its bookmark while the finger is down.
 * Call this from the frame loop: the threshold can pass with no further MIDI.
 */
export function settleTrackPeek(session: Session, now = Date.now()): Session {
  const ui = session.ui;
  if (ui.trackPeek !== null) return session;
  for (let index = 0; index < ui.trackDownTick.length; index++) {
    const downTick = ui.trackDownTick[index] ?? null;
    const downMs = ui.trackDownMs[index] ?? null;
    if (downTick === null && downMs === null) continue;
    if (holdIsShort(downTick, downMs, session.tick, now)) continue;
    const ref = session.project.bookmarks[index];
    if (!ref) continue;
    const origin = screenPlace(ui);
    return {
      ...session,
      ui: { ...applyBookmark(ui, ref), trackPeek: index, trackPeekOrigin: origin },
    };
  }
  return session;
}

function onTrack(session: Session, index: number, press: boolean): Session {
  if (press) {
    if (session.ui.deleteHeld) return clearBookmark(session, index);
    if (session.ui.shiftHeld) return storeBookmark(session, index);
    const trackDownTick = session.ui.trackDownTick.slice();
    const trackDownMs = session.ui.trackDownMs.slice();
    trackDownTick[index] = session.tick;
    trackDownMs[index] = Date.now();
    return { ...session, ui: { ...session.ui, trackDownTick, trackDownMs } };
  }
  const trackDownTick = session.ui.trackDownTick.slice();
  const trackDownMs = session.ui.trackDownMs.slice();
  const started = trackDownTick[index] ?? null;
  const startedMs = trackDownMs[index] ?? null;
  trackDownTick[index] = null;
  trackDownMs[index] = null;
  let ui: UiState = { ...session.ui, trackDownTick, trackDownMs };
  if (started === null && startedMs === null) return { ...session, ui };
  if (ui.trackPeek === index) {
    const origin = ui.trackPeekOrigin;
    ui = { ...ui, trackPeek: null, trackPeekOrigin: null };
    if (origin) ui = restoreTrackPlace(ui, origin);
    return { ...session, ui };
  }
  if (!holdIsShort(started, startedMs, session.tick)) return { ...session, ui };
  const ref = session.project.bookmarks[index];
  if (!ref) return { ...session, ui };
  if (ui.trackLatch === index) {
    const origin = ui.trackOrigin;
    ui = { ...ui, trackLatch: null, trackOrigin: null };
    if (origin) ui = restoreTrackPlace(ui, origin);
    return { ...session, ui };
  }
  const origin = screenPlace(ui);
  return { ...session, ui: { ...applyBookmark(ui, ref), trackLatch: index, trackOrigin: origin } };
}

export function relDelta(value: number): number {
  if (value === 0 || value === 64) return 0;
  if (value < 64) return value;
  return value - 128;
}

export function deleteActiveSet(session: Session): Session {
  if (!session.project.activeSetId) return session;
  return { ...session, project: deleteSet(session.project, session.project.activeSetId) };
}
