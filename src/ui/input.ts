import {
  captureLane,
  captureGenerator,
  capturePaths,
  captureSurface,
  copyScene,
  cycleSet,
  deleteSet,
  resetLane,
  launchScene,
  pasteClipboard,
  record,
  removeSceneFromJournal,
  removeSceneFromSet,
  journalPadIds,
  setCaptureDepth,
  setCaptureIntensity,
  setCaptureScope,
  setPadIds,
  setWander,
  toggleLock,
  toggleMute,
} from "../core/performance.ts";
import { CAPTURE_DEPTHS, CAPTURE_INTENSITIES, CAPTURE_SCOPES, isLane, MENU_CC, STEPS, TRANSITIONS, WANDERS, type LaneId, type Project } from "../core/types.ts";
import { resetControl, writeControl } from "./controls.ts";
import { bindingFor, bindingPaths, pageCount, pageGroup, pagesFor } from "../core/pages.ts";
import { applyBookmark, FOCUS_HOLD_MS, focusHoldTicks, HOLD_MS, HOLD_TICKS, rememberPage, type Notice, type UiState } from "./state.ts";

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

const LOOP = 58;
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
  if (cc === 88) return { ...session, ui: { ...session.ui, muteHeld: press } };
  if (cc === LOOP) return { ...session, ui: { ...session.ui, loopHeld: press } };
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
  if (cc === 52) return onCapture(session, press);
  if (cc === 118 && press) return { ...session, project: record(session.project) };
  if (cc === 85 && press) return { ...session, playing: !session.playing };
  if (cc >= 71 && cc <= 78) return turnEncoder(session, cc - 71, value);
  if (cc === 14) return turnWheel(session, value);
  if (cc >= 40 && cc <= 43) return onTrack(session, cc - 40, press);
  if ((cc === 54 || cc === 55) && press && session.ui.mode === "set") {
    if (cc === 54 && session.ui.deleteHeld) return deleteActiveSet(session);
    return { ...session, project: cycleSet(session.project, cc === 55 ? -1 : 1) };
  }
  return session;
}

function onStep(session: Session, index: number, press: boolean): Session {
  const step = STEPS[index];
  if (!step) return session;
  if (isLane(step)) {
    if (session.ui.deleteHeld && press) {
      return {
        ...session,
        project: resetLane(session.project, step),
        ui: { ...session.ui, heldContext: step, focus: null },
      };
    }
    if (session.ui.loopHeld && press) {
      return { ...session, project: toggleLock(session.project, step) };
    }
    if (session.ui.muteHeld && press) {
      return { ...session, project: toggleMute(session.project, step) };
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
  const row = Math.floor(index / 8);
  const col = index % 8;
  const top = row === 3;
  const second = row === 2;
  const bottom = row === 0;
  if (session.ui.captureHeld) {
    return onCapturePad(session, row, col);
  }
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
  const pads = session.ui.mode === "set" ? setPadIds(session.project) : journalPadIds(session.project);
  if (session.ui.deleteHeld) {
    const id = pads[index];
    if (!id) return session;
    if (session.ui.mode === "set") {
      if (!session.project.activeSetId) return session;
      return { ...session, project: removeSceneFromSet(session.project, session.project.activeSetId, id) };
    }
    return { ...session, project: removeSceneFromJournal(session.project, id) };
  }
  if (session.ui.mode === "set" && session.ui.copyHeld) {
    return { ...session, project: pasteClipboard(session.project) };
  }
  const sceneId = pads[index];
  if (!sceneId) return session;
  return { ...session, project: launchScene(session.project, sceneId, session.tick) };
}

/** Capture overlay: depth, scope, and intensity. Any press blocks the release reroll. */
function onCapturePad(session: Session, row: number, col: number): Session {
  if (row === 0 && col < CAPTURE_INTENSITIES.length) {
    return markCapture(session, setCaptureIntensity(session.project, CAPTURE_INTENSITIES[col]));
  }
  if (row === 1 && col < CAPTURE_SCOPES.length) {
    return markCapture(session, setCaptureScope(session.project, CAPTURE_SCOPES[col]));
  }
  if (row === 2 && col < CAPTURE_DEPTHS.length) {
    return markCapture(session, setCaptureDepth(session.project, CAPTURE_DEPTHS[col]));
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
  const ui = { ...session.ui, focus: focusFor(session, binding, true) };
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
  return {
    ...session,
    project: writeControl(session.project, session.ui.context, binding, delta),
    ui: { ...session.ui, focus: focusFor(session, binding, held) },
  };
}

/** Reroll one generator as soon as its encoder is touched or turned while Capture is held. */
function captureFromEncoder(session: Session, path: string, held: boolean): Session | null {
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
  if (!target) return null;
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
  const pages = pagesFor(session.ui.context);
  const page = pages[Math.min(session.ui.page, pages.length - 1)];
  return page?.bindings[index] ?? null;
}

function onCapture(session: Session, press: boolean): Session {
  if (press) {
    return { ...session, ui: { ...session.ui, captureHeld: true, captureGenerator: null, captureAction: false } };
  }
  const context = session.ui.heldContext ?? session.ui.context;
  const rawPage = session.ui.heldContext ? session.ui.heldPage ?? session.ui.page : session.ui.page;
  const page = Math.min(rawPage, Math.max(0, pageCount(context) - 1));
  const already = session.ui.captureGenerator || session.ui.captureAction;
  let project = session.project;
  if (!already && context === "aux") {
    const surface = auxSurface(project.captureScope, page);
    if (surface) project = captureSurface(project, surface.kind, surface.paths);
  } else if (isLane(context) && !already) {
    project = rerollCapture(project, context, page);
  }
  return {
    ...session,
    project,
    ui: { ...session.ui, captureHeld: false, captureGenerator: null, captureAction: false },
  };
}

function surfaceKind(path: string): "mix" | "perf" | null {
  const store = bindingFor(path)?.store;
  if (store === "macro") return "perf";
  if (store === "mixer") return "mix";
  return null;
}

/** Mixer and macro pages of the section button. Progression, space and global stay put. */
function auxSurface(scope: Project["captureScope"], page: number): { kind: "mix" | "perf"; paths: string[] } | null {
  const pages = pagesFor("aux");
  const current = pages[Math.min(page, Math.max(0, pages.length - 1))];
  if (!current || (current.group !== "mix" && current.group !== "macro")) return null;
  const kind = current.group === "mix" ? "mix" : "perf";
  const chosen = scope === "page" ? [current] : pages.filter((item) => item.group === current.group);
  return { kind, paths: chosen.flatMap((item) => bindingPaths(item)) };
}

function rerollCapture(project: Project, lane: LaneId, page: number): Project {
  if (project.captureScope === "lane") return captureLane(project, lane, "all");
  if (project.captureScope === "page") {
    const pages = pagesFor(lane);
    const current = pages[Math.min(page, Math.max(0, pages.length - 1))];
    return capturePaths(project, lane, current ? bindingPaths(current) : []);
  }
  const scope = pageGroup(lane, page);
  return captureLane(project, lane, scope === "sound" || scope === "notes" || scope === "fx" ? scope : "pattern");
}

function onCopy(session: Session, press: boolean): Session {
  if (!press) return { ...session, ui: { ...session.ui, copyHeld: false } };
  const newest = session.project.journal.at(-1);
  const project = newest ? copyScene(session.project, newest.id) : session.project;
  return { ...session, project, ui: { ...session.ui, copyHeld: true } };
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
