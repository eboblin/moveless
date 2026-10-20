import {
  captureLane,
  captureGenerator,
  capturePaths,
  captureSurface,
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
  setCaptureDepth,
  setCaptureIntensity,
  setCaptureScope,
  setPadIds,
  setWander,
  toggleSolo,
  toggleLock,
  toggleMute,
} from "../core/performance.ts";
import { CAPTURE_CC, CAPTURE_DEPTHS, CAPTURE_SCOPES, contextAtStep, DOWN_CC, isLane, LANES, LOOP_CC, MENU_CC, MUTE_CC, PLAY_CC, TRANSITIONS, UP_CC, WANDERS, type ContextId, type PatternId, type Project } from "../core/types.ts";
import { resetControl, writeControl } from "./controls.ts";
import { bindingFor, bindingPaths, mixerPage, pageCount, pageGroup, pagesFor } from "../core/pages.ts";
import { applyBookmark, FOCUS_HOLD_MS, focusHoldTicks, HOLD_MS, HOLD_TICKS, holdIsShort, mutePeekOpen, peekKind, rememberPage, type Notice, type UiState } from "./state.ts";
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
  const press = msg.data2 > 0;
  if (msg.kind === "note") return onNote(session, msg.data1, press);
  return onCc(session, msg.data1, msg.data2, press);
}

function onNote(session: Session, note: number, press: boolean): Session {
  if (note >= 0 && note <= 7) return touchEncoder(session, note, press);
  if (note === 9) return { ...session, ui: { ...session.ui, wheelTouch: press } };
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
  if (cc === LOOP_CC && press) return applyCapture(session);
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
  const bottom = row === 0;
  if (kind === "capture") return onCapturePad(session, row, col);
  if (session.ui.heldContext && (top || second)) {
    const page = top ? col : 8 + col;
    const held = session.ui.heldContext;
    if (page >= pageCount(held)) return session;
    return { ...session, ui: { ...rememberPage(session.ui, held, page), heldContext: held, heldPage: page } };
  }
  if (session.ui.wheelTouch && top) {
    return selectPage(session, col);
  }
  if (session.ui.wheelTouch && second) {
    return selectPage(session, 8 + col);
  }
  if (session.ui.wheelTouch && bottom) {
    if (col < 4) {
      const transition = TRANSITIONS[col];
      return {
        ...session,
        project: { ...session.project, transition },
        ui: { ...session.ui, notice: modeNotice("TRANSITION", transition.toUpperCase()) },
      };
    }
    const project = setWander(session.project, WANDERS[col - 4], session.tick);
    return {
      ...session,
      project,
      ui: { ...session.ui, notice: modeNotice("WANDER", project.wander ? project.wander.toUpperCase() : "OFF") },
    };
  }
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

/** Capture overlay. Top two rows pick a page. The next row is depth, then scope. The bottom row is intensity. */
function onCapturePad(session: Session, row: number, col: number): Session {
  if (row === 3 || row === 2) {
    const page = row === 3 ? col : 8 + col;
    const context = session.ui.heldContext ?? session.ui.context;
    if (page >= pageCount(context)) return session;
    if (session.ui.heldContext) {
      return { ...session, ui: { ...rememberPage(session.ui, context, page), heldContext: context, heldPage: page } };
    }
    return selectPage(session, page);
  }
  if (row === 1 && col < CAPTURE_DEPTHS.length) {
    return markCapture(session, setCaptureDepth(session.project, CAPTURE_DEPTHS[col]));
  }
  if (row === 1 && col >= 4 && col < 4 + CAPTURE_SCOPES.length) {
    return markCapture(session, setCaptureScope(session.project, CAPTURE_SCOPES[col - 4]));
  }
  if (row === 0 && col === 0) return markCapture(session, setCaptureIntensity(session.project, "clear"));
  if (row === 0 && col >= 1 && col <= 3) {
    const level = (["soft", "medium", "hard"] as const)[col - 1];
    return markCapture(session, setCaptureIntensity(session.project, level));
  }
  return session;
}

function markCapture(session: Session, project: Project): Session {
  return { ...session, project, ui: { ...session.ui, captureAction: true } };
}

const NOTICE_MS = 500;

function modeNotice(title: string, value: string): Notice {
  return { title, value, untilMs: Date.now() + NOTICE_MS };
}

function selectPage(session: Session, page: number): Session {
  if (page >= pageCount(session.ui.context)) return session;
  return { ...session, ui: rememberPage(session.ui, session.ui.context, page) };
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
  if (session.ui.captureHeld) {
    const captured = captureFromEncoder(session, binding.path, true);
    if (captured) return captured;
  }
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
  if (session.ui.captureHeld) {
    const captured = captureFromEncoder(session, binding.path, held);
    if (captured) return captured;
  }
  const turned = writeControl(session.project, session.ui.context, binding, delta, session.ui.detent);
  return {
    ...session,
    project: turned.project,
    ui: { ...session.ui, detent: turned.hold, focus: focusFor(session, binding, held) },
  };
}

/** Reroll one generator as soon as its encoder is touched or turned while Capture is held. */
function captureFromEncoder(session: Session, path: string, held: boolean): Session | null {
  if (mutePeekOpen(session.ui)) {
    if (surfaceKind(path) !== "mix") return null;
    const focusBinding = bindingFor(path) ?? { path, label: path };
    return {
      ...session,
      project: captureSurface(session.project, "mix", [path]),
      ui: { ...session.ui, captureGenerator: path, focus: focusFor(session, focusBinding, held) },
    };
  }
  const context = session.ui.heldContext ?? session.ui.context;
  if (context === "aux") {
    const kind = surfaceKind(path);
    if (!kind) return null;
    const focusBinding = bindingFor(path) ?? { path, label: path };
    return {
      ...session,
      project: captureSurface(session.project, kind, [path]),
      ui: {
        ...session.ui,
        captureGenerator: path,
        focus: focusFor(session, focusBinding, held),
      },
    };
  }
  const target = generatorTarget(path);
  if (!target) {
    if (context !== "fx") return null;
    const focusBinding = bindingFor(path) ?? { path, label: path };
    return {
      ...session,
      project: capturePaths(session.project, context, [path]),
      ui: {
        ...session.ui,
        captureGenerator: path,
        focus: focusFor(session, focusBinding, held),
      },
    };
  }
  const focusBinding = bindingFor(path) ?? { path, label: target };
  return {
    ...session,
    project: captureGenerator(session.project, context, target),
    ui: {
      ...session.ui,
      captureGenerator: target,
      focus: focusFor(session, focusBinding, held),
    },
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

export function generatorTarget(path: string): string | null {
  const euclid = /^(gen[12])\.(length|hits|rotate|probability)$/.exec(path);
  if (euclid) return euclid[1];
  return modulatedBase(path);
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
        captureGenerator: null,
        captureAction: false,
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
      captureGenerator: null,
      captureAction: false,
    },
  };
}

/** One Capture pass. Loop runs this from any screen and leaves the peek where it is. */
function applyCapture(session: Session): Session {
  const { context, page } = captureTarget(session);
  let project = session.project;
  if (mutePeekOpen(session.ui)) project = captureSurface(project, "mix", bindingPaths(mixerPage()));
  else if (context === "aux") {
    const surface = auxSurface(project.captureScope, page);
    if (surface) project = captureSurface(project, surface.kind, surface.paths);
  } else if (isLane(context)) project = rerollCapture(project, context, page);
  return { ...session, project };
}

function captureTarget(session: Session): { context: ContextId; page: number } {
  const context = session.ui.heldContext ?? session.ui.context;
  const rawPage = session.ui.heldContext ? session.ui.heldPage ?? session.ui.page : session.ui.page;
  const page = Math.min(rawPage, Math.max(0, pageCount(context) - 1));
  return { context, page };
}

function surfaceKind(path: string): "mix" | "perf" | null {
  const store = bindingFor(path)?.store;
  if (store === "macro") return "perf";
  if (store === "mixer") return "mix";
  return null;
}

/** Mixer and macro pages of the section button. Progression and global stay put. */
function auxSurface(scope: Project["captureScope"], page: number): { kind: "mix" | "perf"; paths: string[] } | null {
  const pages = pagesFor("aux");
  const current = pages[Math.min(page, Math.max(0, pages.length - 1))];
  if (!current || (current.group !== "mix" && current.group !== "macro")) return null;
  const kind = current.group === "mix" ? "mix" : "perf";
  const chosen = scope === "page" ? [current] : pages.filter((item) => item.group === current.group);
  return { kind, paths: chosen.flatMap((item) => bindingPaths(item)) };
}

function rerollCapture(project: Project, lane: PatternId, page: number): Project {
  if (project.captureScope === "lane") return captureLane(project, lane, "all");
  if (project.captureScope === "page") {
    const pages = pagesFor(lane);
    const current = pages[Math.min(page, Math.max(0, pages.length - 1))];
    return capturePaths(project, lane, current ? bindingPaths(current) : []);
  }
  const scope = pageGroup(lane, page);
  const group = scope === "sound" || scope === "notes" || scope === "fx" ? scope : "pattern";
  return captureLane(project, lane, group);
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
