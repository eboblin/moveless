import {
  randomizeLane,
  randomizePaths,
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
import { CAPTURE_CC, contextAtStep, DOWN_CC, isLane, JOG_CLICK_CC, LANES, LOOP_CC, MENU_CC, MUTE_CC, PLAY_CC, RANDOMIZE_DEPTHS, RANDOMIZE_SCOPES, TRANSITIONS, UP_CC, WANDERS, type ContextId, type PatternId, type Project } from "../core/types.ts";
import { resetControl, writeControl } from "./controls.ts";
import { bindingPaths, mixerPage, pageCount, pageGroup, pagesFor, scopeIncludesPage } from "../core/pages.ts";
import { applyBookmark, FOCUS_HOLD_MS, focusHoldTicks, HOLD_MS, HOLD_TICKS, holdIsShort, mutePeekOpen, peekKind, RANDOMIZE_HINT_MS, rememberPage, settleWheel, type CaptureLine, type Notice, type RandomizeLine, type UiState } from "./state.ts";
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

export function reduce(session: Session, msg: MidiMsg): Session {
  session = { ...session, ui: settleWheel(session.ui) };
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
  if (cc === MUTE_CC) return onMute(session, press);
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
    return { ...session, ui: { ...session.ui, randomizeLatched: !session.ui.randomizeLatched } };
  }
  if (cc === LOOP_CC && press) return applyRandomize(session);
  if (cc === 118 && press) return { ...session, project: recordInto(session.project, session.ui.mode === "set") };
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
        ui: { ...session.ui, heldContext: step, focus: null },
      };
    }
  }
  if (!press) {
    if (session.ui.heldContext !== step) return session;
    const page = session.ui.heldPage ?? session.ui.lanePages[step] ?? 0;
    return {
      ...session,
      ui: { ...rememberPage(session.ui, step, page), heldContext: null, heldPage: null },
    };
  }
  return {
    ...session,
    ui: { ...session.ui, heldContext: step, focus: step === session.ui.context ? session.ui.focus : null },
  };
}

function onPad(session: Session, index: number, press: boolean): Session {
  if (!press) return session;
  const kind = peekKind(session.ui);
  if (kind === "mute") return onMutePad(session, index);
  const row = Math.floor(index / 8);
  const col = index % 8;
  const top = row === 3;
  const second = row === 2;
  const randomize = session.ui.wheelTouch || session.ui.randomizeLatched;
  if (randomize) return onRandomizePad(session, row, col);
  if (kind === "capture") return onCapturePad(session, row, col);
  if (session.ui.heldContext && (top || second)) {
    const page = top ? col : 8 + col;
    const held = session.ui.heldContext;
    if (page >= pageCount(held)) return session;
    return { ...session, ui: { ...rememberPage(session.ui, held, page), heldContext: held, heldPage: page } };
  }
  return onScenePad(session, index);
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

/** Capture overlay. The bottom row is transition, then Off and wander. The rows above are patterns, shifted up. */
function onCapturePad(session: Session, row: number, col: number): Session {
  if (row !== 0) return onScenePad(session, row * 8 + col - 8);
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
    return { ...session, ui: { ...session.ui, wheelTouch: true, wheelReleaseMs: null } };
  }
  if (!session.ui.wheelTouch || session.ui.wheelReleaseMs !== null) return session;
  return { ...session, ui: { ...session.ui, wheelReleaseMs: Date.now() } };
}

function turnWheel(session: Session, value: number): Session {
  const delta = relDelta(value);
  if (!delta) return session;
  const count = pageCount(session.ui.context);
  let page = session.ui.page + (delta > 0 ? 1 : -1);
  if (page < 0) page = 0;
  if (page >= count) page = count - 1;
  return { ...session, ui: rememberPage(session.ui, session.ui.context, page) };
}

function touchEncoder(session: Session, index: number, press: boolean): Session {
  if (!press) {
    const focus = session.ui.focus;
    if (!focus?.held) return session;
    return {
      ...session,
      ui: {
        ...session.ui,
        focus: {
          ...focus,
          held: false,
          untilTick: session.tick + focusHoldTicks(session.project.global.tempo),
          untilMs: Date.now() + FOCUS_HOLD_MS,
        },
      },
    };
  }
  const binding = currentBinding(session, index);
  if (!binding) return session;
  const sameKnob = session.ui.detent?.path === binding.path;
  const ui = {
    ...session.ui,
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
  const held = session.ui.focus?.held ?? false;
  const turned = writeControl(session.project, session.ui.context, binding, delta, session.ui.detent);
  return {
    ...session,
    project: turned.project,
    ui: { ...session.ui, detent: turned.hold, focus: focusFor(session, binding, held) },
  };
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
  if (mutePeekOpen(session.ui)) return mixerPage().bindings[index] ?? null;
  const pages = pagesFor(session.ui.context);
  const page = pages[Math.min(session.ui.page, pages.length - 1)];
  return page?.bindings[index] ?? null;
}

function onMute(session: Session, press: boolean): Session {
  if (press) {
    return {
      ...session,
      ui: {
        ...session.ui,
        muteHeld: true,
        muteWasLatched: session.ui.muteLatched,
        muteDownTick: session.tick,
        muteDownMs: Date.now(),
      },
    };
  }
  const latched = holdIsShort(session.ui.muteDownTick, session.ui.muteDownMs, session.tick)
    ? !session.ui.muteWasLatched
    : session.ui.muteWasLatched;
  return {
    ...session,
    ui: {
      ...session.ui,
      muteHeld: false,
      muteLatched: latched,
      captureLatched: latched ? false : session.ui.captureLatched,
      muteDownTick: null,
      muteDownMs: null,
    },
  };
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
  const latched = holdIsShort(session.ui.captureDownTick, session.ui.captureDownMs, session.tick)
    ? !session.ui.captureWasLatched
    : session.ui.captureWasLatched;
  return {
    ...session,
    ui: {
      ...session.ui,
      captureHeld: false,
      captureLatched: latched,
      muteLatched: latched ? false : session.ui.muteLatched,
      captureDownTick: null,
      captureDownMs: null,
    },
  };
}

/** One randomize pass. Loop runs this from any screen and leaves the peek where it is. */
function applyRandomize(session: Session): Session {
  const { context, page } = randomizeTarget(session);
  let project = session.project;
  if (mutePeekOpen(session.ui)) project = randomizeSurface(project, "mix", bindingPaths(mixerPage()));
  else if (context === "aux") project = rerollAux(project, page);
  else if (isLane(context)) project = rerollLane(project, context, page);
  return { ...session, project };
}

function randomizeTarget(session: Session): { context: ContextId; page: number } {
  const context = session.ui.heldContext ?? session.ui.context;
  const rawPage = session.ui.heldContext ? session.ui.heldPage ?? session.ui.page : session.ui.page;
  const page = Math.min(rawPage, Math.max(0, pageCount(context) - 1));
  return { context, page };
}

/** One budget per aux page. Progression, global, and macro each keep their own store. */
function rerollAux(project: Project, page: number): Project {
  let next = project;
  pagesFor("aux").forEach((item, index) => {
    if (!scopeIncludesPage(next.randomizeScope, "aux", index, page)) return;
    const paths = bindingPaths(item);
    const store = item.bindings.find((binding) => binding)?.store;
    if (store === "progression" || store === "global") next = randomizeSurface(next, store, paths);
    else if (store === "macro") next = randomizeSurface(next, "perf", paths);
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

function onTrack(session: Session, index: number, press: boolean): Session {
  const downs = session.ui.trackDownTick.slice();
  const times = session.ui.trackDownMs.slice();
  if (press) {
    downs[index] = session.tick;
    times[index] = Date.now();
    return { ...session, ui: { ...session.ui, trackDownTick: downs, trackDownMs: times } };
  }
  const started = downs[index];
  const startedMs = times[index];
  downs[index] = null;
  times[index] = null;
  const ui = { ...session.ui, trackDownTick: downs, trackDownMs: times };
  if (started === null && startedMs === null) return { ...session, ui };
  const heldTicks = started === null ? 0 : session.tick - started;
  const heldMs = startedMs === null ? 0 : Date.now() - startedMs;
  if (heldTicks >= HOLD_TICKS || heldMs >= HOLD_MS) {
    const bookmarks = session.project.bookmarks.slice();
    bookmarks[index] = { context: session.ui.context, page: session.ui.page };
    return { ...session, project: { ...session.project, bookmarks }, ui };
  }
  const ref = session.project.bookmarks[index];
  if (!ref) return { ...session, ui };
  return { ...session, ui: { ...applyBookmark(ui, ref), trackDownTick: downs, trackDownMs: times } };
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
