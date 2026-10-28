import {
  randomizeLane,
  randomizePaths,
  commitMacro,
  randomizeSurface,
  clampJournalPage,
  cycleSet,
  deleteSet,
  resetLane,
  resetPattern,
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
import { DECK_GROUPS, fieldAt, focusedGroup, groupAt, recallGroup, resetDeckKnobs, setGroupCell, type DeckGroup } from "../core/deck.ts";
import { CAPTURE_CC, contextAtStep, DOWN_CC, isLane, JOG_CLICK_CC, LANES, LOOP_CC, MENU_CC, MUTE_CC, PLAY_CC, RANDOMIZE_DEPTHS, RANDOMIZE_SCOPES, RECORD_CC, SAMPLE_CC, TRANSITIONS, UP_CC, WANDERS, type ContextId, type PatternId, type Project } from "../core/types.ts";
import { resetControl, writeControl } from "./controls.ts";
import { bindingFor, bindingPaths, deckPage, livePage, mixerPage, pageCount, pageGroup, pageTitle, pagesFor, scopeIncludesPage } from "../core/pages.ts";
import { applyBookmark, auxHidesRandomize, clearFace, FOCUS_HOLD_MS, focusHoldTicks, HOLD_MS, HOLD_TICKS, holdIsShort, MACRO_RETURN_MS, PAGE_TITLE_MS, patternPadsVisible, RANDOMIZE_HINT_MS, rememberPage, restoreTrackPlace, screenPlace, settleRandomize, settleWheel, showPageTitle, toggleRandomize, type CaptureLine, type FaceMode, type MacroReturn, type Notice, type RandomizeLine, type UiState } from "./state.ts";
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
  if (cc === SHIFT) return holdShift(session, press);
  if (cc === MENU_CC && press) {
    const mode = session.ui.mode === "set" ? "journal" : "set";
    return {
      ...session,
      ui: { ...session.ui, mode, notice: modeNotice("MODE", mode === "set" ? "SET" : "JOURNAL") },
    };
  }
  if (cc === 60) return onCopy(session, press);
  if (cc === 119) return holdDelete(session, press);
  if (cc === MUTE_CC) return onFace(session, "mixer", press);
  if (cc === CAPTURE_CC) return onFace(session, "deck", press);
  if (cc === SAMPLE_CC) return onSample(session, press);
  if (cc === JOG_CLICK_CC && press) {
    return { ...session, ui: toggleRandomize(session.ui) };
  }
  if (cc === LOOP_CC && press) return applyRandomize(session);
  if (cc === RECORD_CC && press) return { ...session, project: recordInto(session.project, session.ui.mode === "set") };
  if (cc === PLAY_CC && press) return { ...session, playing: !session.playing };
  if (cc >= 71 && cc <= 78) return turnEncoder(session, cc - 71, value);
  if (cc === 14) return turnWheel(session, value);
  if (cc >= 40 && cc <= 43) return onTrack(session, cc - 40, press);
  if ((cc === DOWN_CC || cc === UP_CC) && press) return onArrow(session, cc === UP_CC ? 1 : -1);
  return session;
}

function onStep(session: Session, index: number, press: boolean): Session {
  if (press && session.ui.face && !session.ui.faceHeld) session = { ...session, ui: clearFace(session.ui) };
  const step = contextAtStep(index);
  if (!step) return session;
  if (!press) {
    if (session.ui.heldContext !== step) return session;
    return {
      ...session,
      ui: {
        ...session.ui,
        heldContext: null,
        heldPage: null,
        pageTitleUntilMs: null,
        pageTitleSlide: null,
      },
    };
  }
  const deleting = isLane(step) && session.ui.deleteHeld;
  const page = session.ui.lanePages[step] ?? 0;
  const placed = rememberPage(
    settleRandomize({
      ...session.ui,
      focus: deleting || step !== session.ui.context ? null : session.ui.focus,
    }),
    step,
    page,
  );
  return {
    ...session,
    project: deleting ? resetLane(session.project, step) : session.project,
    ui: showPageTitle({
      ...placed,
      heldContext: step,
      heldPage: placed.page,
      focus: deleting ? null : placed.focus,
      pageTitleLane: true,
    }),
  };
}

function onPad(session: Session, index: number, press: boolean): Session {
  if (!press) return onPadRelease(session, index);
  const row = Math.floor(index / 8);
  const col = index % 8;
  const top = row === 3;
  const second = row === 2;
  if (session.ui.face === "mixer") return onMutePad(session, index);
  if (session.ui.face === "deck") return pressDeckPad(session, index);
  const holdingAux = session.ui.heldContext === "aux";
  if (session.ui.heldContext && (holdingAux ? top : top || second)) {
    const page = top ? col : 8 + col;
    const held = session.ui.heldContext;
    if (page >= pageCount(held)) return session;
    return {
      ...session,
      ui: settleRandomize({ ...rememberPage(session.ui, held, page), heldContext: held, heldPage: page }),
    };
  }
  const randomize = !auxHidesRandomize(session.ui) && (session.ui.wheelTouch || session.ui.randomizeLatched);
  if (randomize) return onRandomizePad(session, row, col);
  if (!session.ui.heldContext && session.ui.context === "aux" && (session.ui.wheelTouch || session.ui.randomizeLatched) && top) {
    if (col >= pageCount("aux")) return session;
    return { ...session, ui: settleRandomize(rememberPage(session.ui, "aux", col)) };
  }
  if ((session.ui.sampleHeld || session.ui.sampleLatched) && patternPadsVisible(session.ui)) {
    if (row === 0) return onCaptureStrip(session, col);
    return onScenePad(session, index - 8);
  }
  return onScenePad(session, index);
}

function onPadRelease(session: Session, index: number): Session {
  if (session.ui.face !== "deck") return session;
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

/** Randomize overlay. Top two rows pick a page. The next row is depth, then scope. The bottom row is intensity, and a factory restore at the right. */
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
  if (row === 0 && col < 3) {
    const level = (["soft", "medium", "hard"] as const)[col];
    return showRandomizeLine(session, setRandomizeIntensity(session.project, level), "intensity");
  }
  if (row === 0 && col === 7) return restoreFactorySelection(session);
  return session;
}

/** Right pad. Writes factory numbers for the current scope and depth, and leaves intensity where it is. */
function restoreFactorySelection(session: Session): Session {
  const intensity = session.project.randomizeIntensity;
  const restored = applyRandomize({ ...session, project: { ...session.project, randomizeIntensity: "clear" } });
  return { ...restored, project: { ...restored.project, randomizeIntensity: intensity } };
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
    ui: { ...session.ui, sampleHint: { line, untilMs: Date.now() + RANDOMIZE_HINT_MS } },
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
        ...(fresh ? { pageTitleSlide: null, pageTitleLane: session.ui.heldContext !== null } : {}),
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

/** Forward opens the tone strip. Back returns the group knobs. The same way again stays put. */
function turnDeckLayer(session: Session, delta: number): Session {
  const deckLayer = delta > 0 ? "tone" : "group";
  if (session.ui.deckLayer === deckLayer) return session;
  return {
    ...session,
    ui: { ...session.ui, deckLayer, focus: null, detent: null, travel: null },
  };
}

function turnWheel(session: Session, value: number): Session {
  const delta = relDelta(value);
  if (!delta) return session;
  if (session.ui.face === "deck") return turnDeckLayer(session, delta);
  if (session.ui.face) return session;
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
      pageTitleLane: session.ui.heldContext !== null,
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
  const sameKnob = session.ui.detent?.path === binding.path || session.ui.travel?.path === binding.path;
  const keep = !session.ui.shiftHeld && sameKnob;
  const ui = {
    ...session.ui,
    heldEncoders: session.ui.heldEncoders | bit,
    macroGesture: rememberMacro(session.ui.macroGesture, binding),
    macroReturns: [],
    focus: focusFor(session, binding, true),
    detent: keep ? session.ui.detent : null,
    travel: keep ? session.ui.travel : null,
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
  const pending = session.ui.travel?.path === binding.path ? session.ui.travel.pending : 0;
  const turned = writeControl(session.project, session.ui.context, binding, delta, session.ui.detent, pending);
  return {
    ...session,
    project: turned.project,
    ui: {
      ...session.ui,
      macroGesture: fingers ? rememberMacro(session.ui.macroGesture, binding) : session.ui.macroGesture,
      macroReturns: coasting ? session.ui.macroReturns.filter((item) => item.path !== binding.path) : session.ui.macroReturns,
      detent: turned.hold,
      travel: turned.pending === 0 ? null : { path: binding.path, pending: turned.pending },
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
  return shownPage(session)?.bindings[index] ?? null;
}

/** Knobs under the fingers. Mixer and DJ FX replace the page that was open. */
function shownPage(session: Session) {
  if (session.ui.face === "mixer") return mixerPage();
  if (session.ui.face === "deck") return deckPage(focusedGroup(session.project.deck), session.project.deck, session.ui.deckLayer);
  return livePage(session.project, session.ui.context, session.ui.page);
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

/**
 * Mute opens the mixer, Capture opens DJ FX.
 * The screen changes on the press. A short release leaves it there.
 * A long release returns to the mode that was up before the press.
 * A step button leaves a latched mode. The button stays lit while the finger is down,
 * and while the mode is latched.
 */
function onFace(session: Session, which: FaceMode, press: boolean): Session {
  if (press) {
    if (session.ui.faceHeld) return session;
    const leavingDeck = which !== "deck";
    return {
      ...session,
      ui: settleRandomize({
        ...session.ui,
        face: which,
        faceHeld: which,
        faceDownTick: session.tick,
        faceDownMs: Date.now(),
        faceReturn: { latch: session.ui.faceLatch },
        pageTitleUntilMs: null,
        pageTitleSlide: null,
        focus: null,
        detent: null,
        travel: null,
        ...(leavingDeck
          ? {
              deckGesture: null,
              deckGestureTick: null,
              deckLatchedGesture: null,
              deckLatchTick: null,
              deckPads: 0,
            }
          : {}),
      }),
    };
  }
  if (session.ui.faceHeld !== which) return session;
  const short = holdIsShort(session.ui.faceDownTick, session.ui.faceDownMs, session.tick);
  const back = session.ui.faceReturn?.latch ?? null;
  let ui: UiState = {
    ...session.ui,
    faceHeld: null,
    faceDownTick: null,
    faceDownMs: null,
    faceReturn: null,
  };
  if (!short || back === which) {
    const face = short ? null : back;
    ui = { ...ui, face, faceLatch: face, focus: null, detent: null, travel: null };
  } else {
    ui = { ...ui, face: which, faceLatch: which };
  }
  if (ui.face !== "deck") {
    ui = {
      ...ui,
      deckGesture: null,
      deckGestureTick: null,
      deckLatchedGesture: null,
      deckLatchTick: null,
      deckPads: 0,
    };
  }
  return { ...session, ui: settleRandomize(ui) };
}

/** Transition and wander. Short tap latches the row, a long hold keeps it only while the finger is down. */
function onSample(session: Session, press: boolean): Session {
  if (press) {
    return {
      ...session,
      ui: {
        ...session.ui,
        sampleHeld: true,
        sampleWasLatched: session.ui.sampleLatched,
        sampleDownTick: session.tick,
        sampleDownMs: Date.now(),
      },
    };
  }
  const short = holdIsShort(session.ui.sampleDownTick, session.ui.sampleDownMs, session.tick);
  const latched = short ? !session.ui.sampleWasLatched : session.ui.sampleWasLatched;
  return {
    ...session,
    ui: {
      ...session.ui,
      sampleHeld: false,
      sampleLatched: latched,
      sampleDownTick: null,
      sampleDownMs: null,
    },
  };
}

/** One randomize pass. Loop runs this from any screen and leaves the peek where it is. */
function applyRandomize(session: Session): Session {
  if (session.ui.face === "mixer") {
    return { ...session, project: randomizeSurface(session.project, "mix", bindingPaths(mixerPage())) };
  }
  if (session.ui.face === "deck") {
    const knobs = deckPage(focusedGroup(session.project.deck), session.project.deck, session.ui.deckLayer);
    return { ...session, project: randomizeSurface(session.project, "deck", bindingPaths(knobs)) };
  }
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

/** One budget per aux page. Each store keeps its own home. */
function rerollAux(project: Project, page: number): Project {
  let next = project;
  pagesFor("aux").forEach((item, index) => {
    if (!scopeIncludesPage(next.randomizeScope, "aux", index, page)) return;
    const paths = bindingPaths(item);
    const store = item.bindings.find((binding) => binding)?.store;
    if (store === "progression" || store === "global" || store === "bus") next = randomizeSurface(next, store, paths);
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

/** Plus moves toward older journal pages and the next set. Minus moves back. Delete and minus drops the set. */
function onArrow(session: Session, direction: -1 | 1): Session {
  if (session.ui.mode === "set") {
    if (direction < 0 && session.ui.deleteHeld) return deleteActiveSet(session);
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

/** Shift and Delete together restore every lane. No confirm. Mute, lock and the mixer stay. */
function holdShift(session: Session, press: boolean): Session {
  const next = { ...session, ui: { ...session.ui, shiftHeld: press } };
  if (press && next.ui.deleteHeld) return { ...next, project: resetPattern(next.project) };
  return next;
}

function holdDelete(session: Session, press: boolean): Session {
  const next = { ...session, ui: { ...session.ui, deleteHeld: press } };
  if (press && next.ui.shiftHeld) return { ...next, project: resetPattern(next.project) };
  if (press && next.ui.face === "deck") {
    const deck = resetDeckKnobs(next.project.deck);
    if (deck === next.project.deck) return next;
    return { ...next, project: { ...next.project, deck }, ui: { ...next.ui, detent: null, travel: null } };
  }
  return next;
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
