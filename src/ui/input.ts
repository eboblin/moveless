import {
  captureLane,
  captureGenerator,
  copyScene,
  cycleSet,
  deleteSet,
  launchScene,
  pasteClipboard,
  record,
  removeSceneFromSet,
  journalPadIds,
  setPadIds,
  setWander,
  toggleLock,
  toggleMute,
} from "../core/performance.ts";
import type { LaneId, Project, TransitionId, WanderId } from "../core/types.ts";
import { writeControl } from "./controls.ts";
import { pageCount, pagesFor } from "./pages.ts";
import { applyBookmark, focusHoldTicks, HOLD_TICKS, type Notice, type UiState } from "./state.ts";

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
const MENU = 50;
const LANES: LaneId[] = ["kick", "snare", "hat", "perc", "bass", "lead", "chords"];
const TRANSITIONS: TransitionId[] = ["now", "fast", "medium", "slow"];
const WANDERS: WanderId[] = ["fast", "medium", "slow", "glacial"];

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
  if (cc === MENU && press) {
    const mode = session.ui.mode === "set" ? "journal" : "set";
    return { ...session, ui: { ...session.ui, mode } };
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
  if (index < 7) {
    const lane = LANES[index];
    if (session.ui.loopHeld && press) {
      return { ...session, project: toggleLock(session.project, lane) };
    }
    if (session.ui.muteHeld && press) {
      return { ...session, project: toggleMute(session.project, lane) };
    }
    if (!press) {
      if (session.ui.heldLane !== lane) return session;
      const started = session.ui.laneDownTick;
      const tapped = started !== null && session.tick - started < HOLD_TICKS;
      const count = pageCount(lane);
      const page = Math.min(session.ui.page, count - 1);
      return {
        ...session,
        ui: {
          ...session.ui,
          heldLane: null,
          heldPage: null,
          laneDownTick: null,
          context: tapped ? lane : session.ui.context,
          page: tapped ? page : session.ui.page,
        },
      };
    }
    return { ...session, ui: { ...session.ui, heldLane: lane, laneDownTick: session.tick } };
  }
  if (!press) return session;
  if (index === 7) return { ...session, ui: { ...session.ui, context: "mix", page: 0, heldLane: null } };
  if (index === 8) return { ...session, ui: { ...session.ui, context: "global", page: 0, heldLane: null } };
  return session;
}

function onPad(session: Session, index: number, press: boolean): Session {
  if (!press) return session;
  const row = Math.floor(index / 8);
  const col = index % 8;
  const top = row === 3;
  const second = row === 2;
  const bottom = row === 0;
  if (session.ui.heldLane && (top || second)) {
    const page = top ? col : 8 + col;
    const lane = session.ui.heldLane;
    const count = pageCount(lane);
    if (page >= count) return session;
    return { ...session, ui: { ...session.ui, context: lane, page, heldPage: page } };
  }
  if (session.ui.wheelTouch && top) {
    return selectPage(session, col);
  }
  if (session.ui.wheelTouch && second && col < 2) {
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
  if (session.ui.mode === "set" && session.ui.deleteHeld) {
    const id = pads[index];
    if (!id || !session.project.activeSetId) return session;
    return { ...session, project: removeSceneFromSet(session.project, session.project.activeSetId, id) };
  }
  if (session.ui.mode === "set" && session.ui.copyHeld) {
    return { ...session, project: pasteClipboard(session.project) };
  }
  const sceneId = pads[index];
  if (!sceneId) return session;
  return { ...session, project: launchScene(session.project, sceneId, session.tick) };
}

const NOTICE_MS = 500;

function modeNotice(title: string, value: string): Notice {
  return { title, value, untilMs: Date.now() + NOTICE_MS };
}

function selectPage(session: Session, page: number): Session {
  const count = pageCount(session.ui.context);
  if (page >= count) return session;
  return { ...session, ui: { ...session.ui, page } };
}

function turnWheel(session: Session, value: number): Session {
  const delta = relDelta(value);
  if (!delta) return session;
  const count = pageCount(session.ui.context);
  let page = session.ui.page + (delta > 0 ? 1 : -1);
  if (page < 0) page = 0;
  if (page >= count) page = count - 1;
  return { ...session, ui: { ...session.ui, page } };
}

function touchEncoder(session: Session, index: number, press: boolean): Session {
  if (!press) {
    const focus = session.ui.focus;
    if (!focus?.held) return session;
    return {
      ...session,
      ui: { ...session.ui, focus: { ...focus, held: false, untilTick: session.tick + focusHoldTicks(session.project.global.tempo) } },
    };
  }
  const binding = currentBinding(session, index);
  if (!binding) return session;
  const target = session.ui.captureHeld ? generatorTarget(binding.path) : null;
  if (target) {
    return { ...session, ui: { ...session.ui, captureGenerator: target, focus: focusFor(session, binding, true) } };
  }
  return { ...session, ui: { ...session.ui, focus: focusFor(session, binding, true) } };
}

function turnEncoder(session: Session, index: number, value: number): Session {
  const delta = relDelta(value);
  const binding = currentBinding(session, index);
  if (!binding || !delta) return session;
  const held = session.ui.focus?.held ?? false;
  const target = session.ui.captureHeld ? generatorTarget(binding.path) : null;
  if (target) {
    return { ...session, ui: { ...session.ui, captureGenerator: target, focus: focusFor(session, binding, held) } };
  }
  return {
    ...session,
    project: writeControl(session.project, session.ui.context, binding, delta),
    ui: { ...session.ui, focus: focusFor(session, binding, held) },
  };
}

function focusFor(session: Session, binding: { path: string; label: string }, held: boolean) {
  return {
    label: binding.label,
    generator: modulatedBase(binding.path),
    showPattern: binding.path.endsWith(".pattern"),
    held,
    untilTick: session.tick + focusHoldTicks(session.project.global.tempo),
  };
}

export function modulatedBase(path: string): string | null {
  if (path.includes(".g1.") || path.includes(".g2.")) return null;
  const suffixes = [".value", ".pattern", ".cycle", ".amount"];
  const suffix = suffixes.find((item) => path.endsWith(item));
  return suffix ? path.slice(0, -suffix.length) : null;
}

export function generatorTarget(path: string): string | null {
  const event = /^(events\.[ab]\.g[12])\.(level|cycle|offset)$/.exec(path);
  if (event) return event[1];
  return modulatedBase(path);
}

function currentBinding(session: Session, index: number) {
  const pages = pagesFor(session.ui.context);
  const page = pages[Math.min(session.ui.page, pages.length - 1)];
  return page?.bindings[index] ?? null;
}

function onCapture(session: Session, press: boolean): Session {
  if (press) return { ...session, ui: { ...session.ui, captureHeld: true, captureGenerator: null } };
  const lane = session.ui.context;
  const target = session.ui.captureGenerator;
  let project = session.project;
  if (lane !== "mix" && lane !== "global") {
    project = target ? captureGenerator(project, lane, target) : captureLane(project, lane);
  }
  return { ...session, project, ui: { ...session.ui, captureHeld: false, captureGenerator: null } };
}

function onCopy(session: Session, press: boolean): Session {
  if (!press) return { ...session, ui: { ...session.ui, copyHeld: false } };
  const newest = session.project.journal.at(-1);
  const project = newest ? copyScene(session.project, newest.id) : session.project;
  return { ...session, project, ui: { ...session.ui, copyHeld: true } };
}

function onTrack(session: Session, index: number, press: boolean): Session {
  const downs = session.ui.trackDownTick.slice();
  if (press) {
    downs[index] = session.tick;
    return { ...session, ui: { ...session.ui, trackDownTick: downs } };
  }
  const started = downs[index];
  downs[index] = null;
  if (started === null) return { ...session, ui: { ...session.ui, trackDownTick: downs } };
  const held = session.tick - started;
  if (held >= HOLD_TICKS) {
    const bookmarks = session.project.bookmarks.slice();
    bookmarks[index] = { context: session.ui.context, page: session.ui.page };
    return { ...session, project: { ...session.project, bookmarks }, ui: { ...session.ui, trackDownTick: downs } };
  }
  const ref = session.project.bookmarks[index];
  if (!ref) return { ...session, ui: { ...session.ui, trackDownTick: downs } };
  return { ...session, ui: { ...applyBookmark(session.ui, ref), trackDownTick: downs } };
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
