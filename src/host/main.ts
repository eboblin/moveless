import { parseBankParam, type BankView } from "../core/bank.ts";
import { SAMPLE_RATE, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { defaultProject } from "../core/defaults.ts";
import { holdNote, latchStamp, releaseChannel, resetLatch, settleLatch } from "../core/latch.ts";
import { advance, clampJournalPage, heardFx, journalPageCount, sameHeard, wanderCandidates } from "../core/performance.ts";
import { morphHandoffs } from "../core/morph.ts";
import { generatePhrase } from "../core/phrase.ts";
import { loadStoredProject, saveStoredProject, type HostFiles, type StoredUi } from "../core/persist.ts";
import { formatDucks, laneDucks, phraseLoop, soundMotions } from "../dsp/schedule.ts";
import { formatFx } from "../dsp/fx.ts";
import { assembleDeck, behaviorOf, formatDeckCommand, isDeckGroup } from "../core/deck.ts";
import { formatBus, formatGainSpans, packPhraseBody, parseMeterPage } from "../dsp/voice.ts";
import { midiMessage, reduce, settleTrackPeek, type Session } from "../ui/input.ts";
import { CAPTURE_CC, DOWN_CC, isVoice, LANES, MENU_CC, MUTE_CC, PLAY_CC, SAMPLE_CC, TRACK_CC, UP_CC } from "../core/types.ts";
import { advancePulseClock, blinkHalfMs, directionLit, dropLed, faceButtonLed, ledColorAt, menuLed, modeButtonLed, offerLed, padLeds, padPackets, playLed, PULSE_CLOCK_IDLE, sceneShadeStep, STEP_ICON_CC, stepIconColors, stepLampKey, stepLeds, takeLeds, trackLeds, type PulseClock } from "../ui/leds.ts";
import { plotAmount, plotMinus } from "../ui/digits.ts";
import {
  CAPTION_BOX_BOTTOM,
  CAPTION_BOX_TOP,
  CHAR_W,
  DIGIT_Y,
  FONT_H,
  HEADER_H,
  HEIGHT,
  PARAM_COL_W,
  SEP_Y,
  WIDTH,
  VIZ_H,
  cellTextX,
  deckFrame,
  coverBank,
  loadWidth,
  laneMark,
  nudgePlayhead,
  pageTitlePaintKey,
  pageTitleVisible,
  readoutKey,
  renderScreen,
  slidePageTitle,
  strokeMeters,
  type Screen,
} from "../ui/screen.ts";
import { resetWaveform, serviceWaveform } from "../ui/wave-audio.ts";
import { applyWavePages, resetWaveScroll, strokeWaveform, strokeWaveScroll, type WaveTape } from "../ui/wave.ts";
import { defaultUi, focusVisible, peekKind, restoreUi, screenPlace, settleWheel, type UiState } from "../ui/state.ts";
import type { Project } from "../core/types.ts";

interface HostGlobals {
  clear_screen?: () => void;
  set_pixel?: (x: number, y: number, value: number) => void;
  print?: (x: number, y: number, text: string, color: number) => void;
  fill_rect?: (x: number, y: number, w: number, h: number, value: number) => void;
  text_width?: (text: string) => number;
  set_font?: (path: string) => boolean;
  get_font_height?: () => number;
  move_midi_internal_send?: (packet: number[]) => void;
  host_module_set_param?: (key: string, value: string) => void;
  host_module_get_param?: (key: string) => string | null;
  shadow_set_param?: (slot: number, key: string, value: string) => void;
  shadow_get_param?: (slot: number, key: string) => string | null;
  host_ensure_dir?: (path: string) => boolean | void;
  host_file_exists?: (path: string) => boolean;
  host_read_file?: (path: string) => string | null;
  host_write_file?: (path: string, content: string) => boolean;
}

/** Schwung 4×5 param-page face — shorter than the host’s default 5×7. */
const MODULE_FONT = "/data/UserData/schwung/modules/overtake/moveless/font.png";
const AUTOSAVE_MS = 2000;

function hostFiles(): HostFiles {
  const host = globalThis as HostGlobals;
  return {
    ensure_dir: host.host_ensure_dir?.bind(host),
    file_exists: host.host_file_exists?.bind(host),
    read_file: host.host_read_file?.bind(host),
    write_file: host.host_write_file?.bind(host),
  };
}

function uiSlice(session: Session): StoredUi {
  return {
    context: session.ui.context,
    page: session.ui.page,
    mode: session.ui.mode,
    playing: session.playing,
    sampleLatched: session.ui.sampleLatched,
    randomizeLatched: session.ui.randomizeParked ?? session.ui.randomizeLatched,
    face: session.ui.faceLatch,
    deckLayer: session.ui.deckLayer,
  };
}

function boot(): Session {
  const stored = loadStoredProject(hostFiles());
  if (!stored) return { project: defaultProject(), ui: defaultUi(), tick: 0, playing: true };
  return {
    project: stored.project,
    ui: restoreUi(stored.ui),
    tick: 0,
    playing: stored.ui.playing,
  };
}

/** Placeholder until `init()` loads from disk (or defaults). */
let session: Session = { project: defaultProject(), ui: defaultUi(), tick: 0, playing: true };
let voiceOn = false;
let clockMs = 0;
let sentMs = 0;
let phraseProject: Project | null = null;
let phraseBody = "";
let phraseLatch = "";
let voiceStep = -1;
let voiceMorph = false;
let projectDirty = false;
let dirtySinceMs = 0;
let bank: BankView = { phase: "off", percent: 0 };
let bankDismissed = false;
let bankAt = 0;

/** Glide so a new reading moves the line instead of jumping it. */
const LOAD_TAU_MS = 450;

function pollAudioLoad(now: number): void {
  if (now - sent.loadAt >= 100) {
    sent.loadAt = now;
    const host = globalThis as HostGlobals;
    const raw = host.host_module_get_param?.("cpu") ?? host.shadow_get_param?.(0, "overtake_dsp:cpu");
    if (typeof raw === "string") {
      const n = Number.parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 0 && n <= 99) sent.target = n;
    }
  }
  const dt = sent.shownAt === 0 ? 0 : Math.max(0, Math.min(50, now - sent.shownAt));
  sent.shownAt = now;
  if (dt > 0) sent.shown += (sent.target - sent.shown) * (1 - Math.exp(-dt / LOAD_TAU_MS));
  const width = loadWidth(sent.shown);
  if (width === sent.width) return;
  sent.width = width;
  sent.load = sent.shown;
}

function markDirty(before: Project): void {
  if (session.project === before) return;
  projectDirty = true;
  dirtySinceMs = Date.now();
}

function flushSave(): void {
  if (!projectDirty) return;
  if (saveStoredProject(session.project, uiSlice(session), hostFiles())) {
    projectDirty = false;
  }
}

function maybeAutosave(): void {
  if (!projectDirty) return;
  if (Date.now() - dirtySinceMs < AUTOSAVE_MS) return;
  flushSave();
}

/** Fade schedule for the voice. Lane 7 is the fx return. The mixer stays where the hand left it. */
function gainTrailer(project: Session["project"]): string {
  const tempo = Math.max(1, project.global.tempo);
  return formatGainSpans(morphHandoffs(project).map((handoff) => ({
    lane: handoff.lane === "fx" ? 7 : LANES.indexOf(handoff.lane),
    kind: handoff.kind === "in" ? "i" : handoff.kind === "out" ? "o" : "d",
    start: tickToSample(handoff.startTick, tempo),
    commit: tickToSample(handoff.commitTick, tempo),
    end: tickToSample(handoff.endTick, tempo),
  })));
}

function sendBlock(value: string): void {
  const host = globalThis as HostGlobals;
  if (host.host_module_set_param) host.host_module_set_param("block", value);
  else host.shadow_set_param?.(0, "overtake_dsp:block", value);
}

function syncVoice(reset: boolean): void {
  const tempo = session.project.global.tempo;
  if (!session.playing) {
    if (voiceOn) sendBlock(`S|${tempo}`);
    voiceOn = false;
    sent.phrase = "";
    sent.gain = "";
    sent.deck = "";
    return;
  }
  const step = Math.floor(session.tick / 48);
  const morphing = session.project.morph !== null;
  const boundary = morphing !== voiceMorph || step !== voiceStep;
  const latch = Math.round(session.project.progression.count) <= 0 ? latchStamp() : "";
  const latchChanged = latch !== phraseLatch;
  const heardSame = phraseProject !== null && sameHeard(phraseProject, session.project);
  const gains = gainTrailer(session.project);
  if ((!heardSame && (!morphing || boundary || reset)) || latchChanged || gains !== sent.gain) {
    const phrase = generatePhrase(session.project);
    phraseBody = packPhraseBody(
      phraseLoop(session.project, phrase),
      soundMotions(session.project, phrase),
      formatFx(heardFx(session.project), session.project.global.bar),
      formatBus(session.project.bus),
      gains,
      formatDucks(laneDucks(session.project)),
    );
    sent.gain = gains;
    phraseProject = session.project;
    sent.phrase = "";
    phraseLatch = latch;
  }
  voiceStep = step;
  voiceMorph = morphing;
  const now = Date.now();
  const deck = deckCommand();
  const sameBody = !reset && phraseBody.length > 0 && sent.phrase === phraseBody;
  const phraseDue = reset || sent.phrase !== phraseBody || now - sentMs > 400;
  if (phraseDue) {
    sendBlock(sameBody ? `K|${tempo}` : `P|${tempo}|${reset ? 1 : 0}|${phraseBody}`);
    if (!sameBody) sent.phrase = phraseBody;
    sentMs = now;
  }
  if (phraseDue || deck !== sent.deck) {
    sendBlock(deck);
    sent.deck = deck;
  }
  voiceOn = true;
}

function deckEdge(before: UiState, after: UiState): boolean {
  return before.deckGesture !== after.deckGesture
    || before.deckLatchedGesture !== after.deckLatchedGesture
    || before.deckPress !== after.deckPress
    || before.face !== after.face;
}

/** DJ FX is audible while Capture is showing it. */
function deckOpen(ui: UiState): boolean {
  return ui.face === "deck";
}

/** The strip is on screen, including a held preview. */
function deckVisible(ui: UiState): boolean {
  return deckOpen(ui);
}

function deckCommand(): string {
  const heard = session.ui.deckGesture ?? session.ui.deckLatchedGesture;
  const group = heard && isDeckGroup(heard) ? heard : null;
  const open = deckOpen(session.ui);
  const barBeats = session.project.global.bar;
  return formatDeckCommand({
    gesture: open && group ? behaviorOf(session.project.deck, group) : null,
    press: open && group ? session.ui.deckPress : 0,
    knobs: group ? assembleDeck(session.project.deck, group, barBeats) : session.project.deck,
    warm: open,
    seed: session.project.global.seed,
    barBeats,
  });
}

function blit(pixels: Uint8Array): void {
  const host = globalThis as HostGlobals;
  if (!host.clear_screen || !host.set_pixel) return;
  host.clear_screen();
  for (let i = 0; i < pixels.length; i++) {
    if (!pixels[i]) continue;
    host.set_pixel(i % WIDTH, Math.floor(i / WIDTH), 1);
  }
}

let sentSteps: number[] = [];
let sentPads: number[] = [];
/** Unsent LED MIDI. Drained a block at a time so a full repaint is not dropped. */
const ledOut = new Map<number, number[]>();
/** Pad packets still owed, one per drain, so a pulse arms after its colour has latched. */
const padQueue = new Map<number, number[][]>();
const pendingClocks: number[][] = [];
const LED_BUDGET = 16;
let sentTracks: number[] = [];
let sentIcons: number[] = [];
let sentMenu = -1;
let sentPlay = -1;
let sentMute = -1;
let sentCapture = -1;
let sentSample = -1;
let sentUp = -1;
let sentDown = -1;
/**
 * What the last frame already handed to dsp.so, and the load line on screen.
 * Kept beside the paint cache: both exist so a frame can skip work it already did.
 */
const sent = {
  phrase: "",
  gain: "",
  deck: "",
  load: 0,
  loadAt: 0,
  target: 0,
  shown: 0,
  shownAt: 0,
  width: -1,
};
const frame = new Uint8Array(WIDTH * HEIGHT);
let paintProject: Project | null = null;
let paintUi: UiState | null = null;
let paintPlaying = false;
let paintLatch = "";
let paintLoad = -1;
let paintNotice = false;
let paintHint = false;
let paintCapture = false;
let paintFocus = false;
let paintPeek: string | null = null;
let paintTitleKey = -1;
let paintLane: object | null = null;
let paintDigits = "";
let ledPhase = -1;
let ledShade = -1;
let ledLamps = "";
let ledProject: Project | null = null;
let ledUi: UiState | null = null;
let ledPlaying = false;
let ledPeek: string | null = null;
/** Deck fast path has drawn both bands since the last full paint. */
let deckFastLatched = false;
/** Mixer strips have had one full paint since the face opened. */
let mixerFastLatched = false;
let mixerMeterText: string | null = null;
let deckColumn = Number.NaN;
let deckSpan = Number.NaN;
let deckTape: WaveTape | null = null;
let chromeDeck: Project["deck"] | null = null;
let chromeFocus = false;
let chromeFocusPath = "";
let chromeGesture = "";
let chromeWidth = -2;
let chromeBar = Number.NaN;
let deckCoverKey = "";
let gateProject: Project | null = null;
let gateStep = Number.NaN;
let gateList: readonly number[] = LANES.map(() => 0);
let pulseClock: PulseClock = PULSE_CLOCK_IDLE;

function blitColumns(pixels: Uint8Array, xs: readonly number[], y0: number, y1: number): void {
  const pixel = (globalThis as HostGlobals).set_pixel;
  if (!pixel) return;
  for (const x of xs) {
    if (x < 0 || x >= WIDTH) continue;
    for (let y = y0; y <= y1; y++) pixel(x, y, pixels[y * WIDTH + x] ? 1 : 0);
  }
}

type PaintDelta = "same" | "full" | "head" | "viz" | "readout" | "caption";

function focusSame(a: UiState["focus"], b: UiState["focus"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.path === b.path && a.label === b.label && a.generator === b.generator && a.held === b.held && a.showPattern === b.showPattern;
}

/** Encoder travel and the detent hold do not change a pixel. */
function samePaintUi(a: UiState | null, b: UiState): boolean {
  if (!a) return false;
  if (a === b) return true;
  return a.context === b.context
    && a.page === b.page
    && a.mode === b.mode
    && a.wheelTouch === b.wheelTouch
    && a.face === b.face
    && a.deckLayer === b.deckLayer
    && a.deckGesture === b.deckGesture
    && a.deckGestureTick === b.deckGestureTick
    && a.deckLatchedGesture === b.deckLatchedGesture
    && a.deckLatchTick === b.deckLatchTick
    && a.deckPress === b.deckPress
    && a.heldContext === b.heldContext
    && a.heldPage === b.heldPage
    && a.pageTitleLane === b.pageTitleLane
    && a.pageTitleSlide === b.pageTitleSlide
    && a.pageTitleUntilMs === b.pageTitleUntilMs
    && a.notice === b.notice
    && a.randomizeHint === b.randomizeHint
    && a.sampleHint === b.sampleHint
    && a.macroReturns === b.macroReturns
    && a.lanePages === b.lanePages
    && focusSame(a.focus, b.focus);
}

function shownWorking(project: Project, ui: UiState): object | null {
  if (ui.face === "mixer" || ui.face === "deck") return null;
  const context = ui.heldContext ?? ui.context;
  if (!isVoice(context)) return null;
  return project.working[context];
}

function rememberPaint(
  ui: UiState,
  notice: boolean,
  hint: boolean,
  capture: boolean,
  focus: boolean,
  peek: string | null,
  latch: string,
  titleKey: number,
  lane: object | null,
  digits: string,
): void {
  paintProject = session.project;
  paintUi = ui;
  paintPlaying = session.playing;
  paintNotice = notice;
  paintHint = hint;
  paintCapture = capture;
  paintFocus = focus;
  paintPeek = peek;
  paintLatch = latch;
  paintLoad = sent.load;
  paintTitleKey = titleKey;
  paintLane = lane;
  paintDigits = digits;
}

function screenDelta(now: number): PaintDelta {
  const ui = session.ui;
  const notice = !!(ui.notice && now < ui.notice.untilMs);
  const hint = !!(ui.randomizeHint && now < ui.randomizeHint.untilMs);
  const capture = !!(ui.sampleHint && now < ui.sampleHint.untilMs);
  const focus = focusVisible(ui.focus, session.tick, now);
  const peek = peekKind(ui);
  const latch = Math.round(session.project.progression.count) <= 0 ? latchStamp() : "";
  const titleKey = pageTitlePaintKey(ui, now);
  const uiSame = paintUi === ui || samePaintUi(paintUi, ui);
  const flagsSame = uiSame
    && paintPlaying === session.playing
    && paintNotice === notice
    && paintHint === hint
    && paintCapture === capture
    && paintFocus === focus
    && paintPeek === peek
    && paintLatch === latch
    && paintLoad === sent.load;
  const pictureSame = flagsSame && paintProject === session.project && paintTitleKey === titleKey;
  if (pictureSame) {
    if (!session.playing || deckVisible(ui)) return "same";
    return "head";
  }
  const titleOnly = flagsSame && paintProject === session.project && paintTitleKey >= 0 && titleKey >= 0 && paintTitleKey !== titleKey;
  const lane = shownWorking(session.project, ui);
  const digits = readoutKey(session.project, ui);
  const prevLane = paintLane;
  const prevDigits = paintDigits;
  const projectChanged = paintProject !== session.project;
  rememberPaint(ui, notice, hint, capture, focus, peek, latch, titleKey, lane, digits);
  if (titleOnly) return "caption";
  const quietFace = !notice && ui.face !== "mixer" && ui.face !== "deck";
  if (projectChanged && flagsSame && quietFace && session.project.morph) {
    if (lane === prevLane) return digits === prevDigits ? (session.playing ? "head" : "same") : "readout";
    return "viz";
  }
  return "full";
}

function currentGates(): readonly number[] {
  if (!session.playing) {
    gateProject = session.project;
    gateStep = -1;
    if (gateList.length !== LANES.length || gateList.some((gate) => gate !== 0)) gateList = LANES.map(() => 0);
    return gateList;
  }
  const step = Math.floor(Math.max(0, session.tick) / SIXTEENTH_TICKS);
  if (gateProject === session.project && gateStep === step) return gateList;
  const phrase = generatePhrase(session.project);
  const at = Math.max(0, session.tick) / SIXTEENTH_TICKS;
  gateList = LANES.map((lane) => laneMark(session.project, phrase, lane, at));
  gateProject = session.project;
  gateStep = step;
  return gateList;
}

function ledsDue(): boolean {
  const phase = Math.floor(Date.now() / blinkHalfMs(session.project.global.tempo));
  const peek = peekKind(session.ui);
  const shade = sceneShadeStep(session.project, session.tick);
  if (ledPhase !== phase || ledShade !== shade || ledProject !== session.project || ledUi !== session.ui || ledPlaying !== session.playing || ledPeek !== peek) return true;
  if (!session.playing) return false;
  const step = Math.floor(Math.max(0, session.tick) / SIXTEENTH_TICKS);
  return gateProject !== session.project || gateStep !== step;
}

function ledsChanged(gates: readonly number[]): boolean {
  const phase = Math.floor(Date.now() / blinkHalfMs(session.project.global.tempo));
  const peek = peekKind(session.ui);
  const shade = sceneShadeStep(session.project, session.tick);
  const lamps = stepLampKey(session.ui.context, gates);
  if (ledPhase === phase && ledShade === shade && ledLamps === lamps && ledProject === session.project && ledUi === session.ui && ledPlaying === session.playing && ledPeek === peek) return false;
  ledPhase = phase;
  ledShade = shade;
  ledLamps = lamps;
  ledProject = session.project;
  ledUi = session.ui;
  ledPlaying = session.playing;
  ledPeek = peek;
  return true;
}

function bankCovered(): boolean {
  if (bank.phase === "load") return true;
  return bank.phase === "fail" && !bankDismissed;
}

function pollBank(force: boolean): void {
  const now = Date.now();
  if (!force && now - bankAt < 100) return;
  bankAt = now;
  const next = parseBankParam(readParam("bank"));
  if (next.phase !== bank.phase || next.percent !== bank.percent) bank = next;
}

function readParam(key: string): string | null {
  const host = globalThis as HostGlobals;
  const raw = host.host_module_get_param?.(key) ?? host.shadow_get_param?.(0, `overtake_dsp:${key}`);
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function mixerMeters(): ReturnType<typeof parseMeterPage> {
  if (session.ui.face !== "mixer") return null;
  return parseMeterPage(readParam("meters"));
}

/** A caption or a notice covers the faders, so a strip update would punch through the hatch. */
function mixerCovered(ui: UiState, now: number): boolean {
  if (ui.notice && now < ui.notice.untilMs) return true;
  if (pageTitleVisible(ui, now)) return true;
  return false;
}

function paintScreen(): void {
  let wave: WaveTape | null = null;
  if (deckVisible(session.ui)) {
    wave = serviceWaveform(session.project);
    applyWavePages(wave, [readParam("wave0"), readParam("wave1")]);
  }
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, Date.now(), frame, sent.load, wave, mixerMeters());
  if (bankCovered()) coverBank(frame, bank);
  blit(screen.pixels);
  if (bankCovered()) return;
  paintHostReadout(screen);
}

/** Faders stay. Only the eight level columns move. */
function paintMixerFast(now: number): void {
  const text = readParam("meters");
  const delta = screenDelta(now);
  if (delta === "full" || !mixerFastLatched) {
    paintScreen();
    mixerFastLatched = true;
    mixerMeterText = text;
    return;
  }
  if (text === mixerMeterText) return;
  mixerMeterText = text;
  const focus = focusVisible(session.ui.focus, session.tick, now) ? session.ui.focus?.label ?? null : null;
  strokeMeters(parseMeterPage(text), focus, hostRect);
}

function hostRect(x: number, y: number, w: number, h: number, value: number): void {
  if (w <= 0 || h <= 0) return;
  const host = globalThis as HostGlobals;
  if (host.fill_rect) {
    host.fill_rect(x, y, w, h, value);
    return;
  }
  const pixel = host.set_pixel;
  if (!pixel) return;
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) pixel(col, row, value);
  }
}

function blitRows(pixels: Uint8Array, y0: number, y1: number): void {
  const pixel = (globalThis as HostGlobals).set_pixel;
  if (!pixel) return;
  for (let y = y0; y < y1; y++) {
    const row = y * WIDTH;
    for (let x = 0; x < WIDTH; x++) {
      if (pixels[row + x]) pixel(x, y, 1);
    }
  }
}

function paintHostReadout(screen: Screen): void {
  const host = globalThis as HostGlobals;
  const invertedCells = new Set<number>();
  for (const label of screen.labels) {
    if (label.invert && label.cell !== undefined) invertedCells.add(label.cell);
  }
  const cellTop = HEADER_H + VIZ_H;
  const cellH = HEIGHT - cellTop;
  for (const cell of invertedCells) {
    host.fill_rect?.(cell * PARAM_COL_W, cellTop, PARAM_COL_W, cellH, 1);
  }
  for (const digit of screen.digits) {
    const color = digit.invert ? 0 : 1;
    const plot = (x: number, y: number) => {
      host.set_pixel?.(x, y, color);
    };
    plotAmount(digit.cell * PARAM_COL_W, PARAM_COL_W, DIGIT_Y, digit.amount, plot);
  }
  for (const label of screen.labels) {
    const width = host.text_width?.(label.text) ?? label.text.length * CHAR_W;
    const x = label.cell !== undefined ? cellTextX(label.cell, label.text, width) : label.x;
    if (label.cell !== undefined) {
      const color = invertedCells.has(label.cell) ? 0 : 1;
      host.print?.(x, label.y, label.text, color);
      if (label.minus) {
        plotMinus(label.cell * PARAM_COL_W, PARAM_COL_W, DIGIT_Y, (px, py) => {
          host.set_pixel?.(px, py, color);
        });
      }
      continue;
    }
    if (!label.invert) {
      host.print?.(x, label.y, label.text, 1);
      continue;
    }
    const height = host.get_font_height?.() || FONT_H;
    const x0 = Math.max(0, x - 1);
    const y0 = Math.max(0, label.y - 1);
    const x1 = Math.min(WIDTH, x + width + 1);
    const y1 = Math.min(HEIGHT, label.y + height + 1);
    host.fill_rect?.(x0, y0, x1 - x0, y1 - y0, 1);
    host.print?.(x, label.y, label.text, 0);
  }
  for (const cell of screen.dim) {
    const x0 = cell * PARAM_COL_W;
    for (let y = cellTop; y < HEIGHT; y++) {
      for (let x = x0; x < x0 + PARAM_COL_W; x++) {
        if ((x + y) % 2 !== 0) host.set_pixel?.(x, y, 0);
      }
    }
  }
}

/** Notice, hint, or the sliding page title covers the platter. Those frames stay on the full blit. */
function deckOverlay(ui: UiState, now: number): boolean {
  if (ui.notice && now < ui.notice.untilMs) return true;
  if (ui.randomizeHint && now < ui.randomizeHint.untilMs) return true;
  if (ui.sampleHint && now < ui.sampleHint.untilMs) return true;
  if (pageTitleVisible(ui, now)) return true;
  return false;
}

function deckChromeStale(now: number): boolean {
  const focusOn = focusVisible(session.ui.focus, session.tick, now);
  const path = focusOn && session.ui.focus ? `${session.ui.focus.path}\0${session.ui.focus.label}` : "";
  const gesture = `${session.ui.deckLayer}\0${session.ui.deckGesture ?? ""}\0${session.ui.deckLatchedGesture ?? ""}`;
  return chromeDeck !== session.project.deck
    || chromeFocus !== focusOn
    || chromeFocusPath !== path
    || chromeGesture !== gesture
    || chromeWidth !== sent.width
    || chromeBar !== session.project.global.bar;
}

function paintDeckChrome(now: number): void {
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, now, frame, sent.load, null);
  hostRect(0, 0, WIDTH, HEADER_H, 0);
  blitRows(screen.pixels, 0, HEADER_H);
  hostRect(0, SEP_Y, WIDTH, 1, 1);
  const paramTop = HEADER_H + VIZ_H;
  hostRect(0, paramTop, WIDTH, HEIGHT - paramTop, 0);
  paintHostReadout(screen);
  chromeDeck = session.project.deck;
  chromeFocus = focusVisible(session.ui.focus, session.tick, now);
  chromeFocusPath = chromeFocus && session.ui.focus ? `${session.ui.focus.path}\0${session.ui.focus.label}` : "";
  chromeGesture = `${session.ui.deckLayer}\0${session.ui.deckGesture ?? ""}\0${session.ui.deckLatchedGesture ?? ""}`;
  chromeWidth = sent.width;
  chromeBar = session.project.global.bar;
}

function paintDeckWave(wave: WaveTape, head: number, span: number, shift: number): void {
  const yTop = HEADER_H;
  const h = VIZ_H - 1;
  const pixel = (globalThis as HostGlobals).set_pixel;
  const view = { x: 0, y: yTop, w: WIDTH, h, head, span, gain: 1, stylus: true };
  const plot = (x: number, y: number, value: number) => pixel?.(x, y, value);
  if (shift !== 0 && strokeWaveScroll(wave, view, shift, hostRect, plot)) return;
  hostRect(0, yTop, WIDTH, h, 0);
  strokeWaveform(wave, view, hostRect, plot);
}

/** Platter column and knob readout, each only when that band changed. */
function paintDeckFast(now: number): boolean {
  const wave = serviceWaveform(session.project);
  applyWavePages(wave, [readParam("wave0"), readParam("wave1")]);
  const picture = deckFrame(session.project, session.ui, session.tick);
  const head = wave.readHead != null ? wave.readHead : picture.head;
  const span = wave.pastSpan > 0 ? wave.pastSpan : picture.span;
  const column = span > 0 ? Math.floor((head * WIDTH) / span) : 0;
  const waveDirty = !deckFastLatched || column !== deckColumn || span !== deckSpan || wave !== deckTape;
  const chromeDirty = !deckFastLatched || deckChromeStale(now);
  const shift = deckFastLatched && wave === deckTape && span === deckSpan && Number.isFinite(deckColumn) ? column - deckColumn : 0;
  if (chromeDirty) paintDeckChrome(now);
  if (waveDirty) paintDeckWave(wave, head, span, shift);
  deckFastLatched = true;
  deckColumn = column;
  deckSpan = span;
  deckTape = wave;
  return waveDirty;
}

function deckCoverStamp(now: number): string {
  const ui = session.ui;
  return `${pageTitlePaintKey(ui, now)}|${ui.notice?.title ?? ""}|${ui.notice?.value ?? ""}|${ui.randomizeHint?.line ?? ""}|${ui.sampleHint?.line ?? ""}`;
}

/** Wave and caption share the platter. A steady caption does not redraw the band. */
function paintDeckCovered(now: number): void {
  const wave = serviceWaveform(session.project);
  applyWavePages(wave, [readParam("wave0"), readParam("wave1")]);
  const picture = deckFrame(session.project, session.ui, session.tick);
  const head = wave.readHead != null ? wave.readHead : picture.head;
  const span = wave.pastSpan > 0 ? wave.pastSpan : picture.span;
  const column = span > 0 ? Math.floor((head * WIDTH) / span) : 0;
  const waveDirty = !deckFastLatched || column !== deckColumn || span !== deckSpan || wave !== deckTape;
  const stamp = deckCoverStamp(now);
  const chromeDirty = !deckFastLatched || deckChromeStale(now);
  if (chromeDirty) paintDeckChrome(now);
  if (!waveDirty && stamp === deckCoverKey && deckFastLatched) return;
  deckCoverKey = stamp;
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, now, frame, sent.load, wave, null);
  hostRect(0, HEADER_H, WIDTH, VIZ_H - 1, 0);
  blitRows(screen.pixels, HEADER_H, HEADER_H + VIZ_H - 1);
  deckFastLatched = true;
  deckColumn = column;
  deckSpan = span;
  deckTape = wave;
  resetWaveScroll();
}

function paintViz(now: number, readout: boolean): void {
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, now, frame, sent.load, null, mixerMeters());
  hostRect(0, HEADER_H, WIDTH, VIZ_H - 1, 0);
  blitRows(screen.pixels, HEADER_H, HEADER_H + VIZ_H - 1);
  if (!readout) return;
  const top = HEADER_H + VIZ_H;
  hostRect(0, top, WIDTH, HEIGHT - top, 0);
  paintHostReadout(screen);
}

function paintReadout(now: number): void {
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, now, frame, sent.load, null, mixerMeters());
  const top = HEADER_H + VIZ_H;
  hostRect(0, top, WIDTH, HEIGHT - top, 0);
  paintHostReadout(screen);
}

function paintCaption(now: number): void {
  if (!slidePageTitle(frame, session.project, session.ui, now)) {
    paintScreen();
    return;
  }
  const y0 = CAPTION_BOX_TOP;
  const y1 = CAPTION_BOX_BOTTOM;
  hostRect(0, y0, WIDTH, y1 - y0 + 1, 0);
  blitRows(frame, y0, y1 + 1);
}

function arrowBrightness(): { up: number; down: number } {
  if (session.ui.mode === "set") {
    const index = session.project.sets.findIndex((set) => set.id === session.project.activeSetId);
    return directionLit(Math.max(0, index), session.project.sets.length);
  }
  // Journal pages count down toward the newest, so Plus lights while a newer page exists.
  const count = journalPageCount(session.project.journal.length);
  const page = clampJournalPage(session.ui.journalPage, session.project.journal.length);
  return directionLit(count - 1 - page, count);
}

function paintLeds(levels?: readonly number[]): void {
  const host = globalThis as HostGlobals;
  if (!host.move_midi_internal_send) return;
  const now = Date.now();
  const tempo = session.project.global.tempo;
  const tick = session.tick;
  stepLeds(session.project, session.ui.context, levels).forEach((led, index) => {
    const note = 16 + index;
    const packets = padPackets(note, led);
    const key = ledPacketKey(led);
    if (sentSteps[index] !== key) {
      sentSteps[index] = key;
      padQueue.set(note, packets);
    }
    const queued = padQueue.get(note);
    if (!queued?.length) return;
    offerLed(ledOut, queued[0]);
    if (queued[0][1] === 0x90) dropLed(ledOut, 0x99, note);
  });
  stepIconColors(session.project, session.ui.context, session.ui.heldContext).forEach((color, index) => {
    if (sentIcons[index] === color) return;
    sentIcons[index] = color;
    offerLed(ledOut, [0x0b, 0xb0, STEP_ICON_CC + index, color]);
  });
  const menu = menuLed(session.ui.mode);
  if (sentMenu !== menu) {
    sentMenu = menu;
    offerLed(ledOut, [0x0b, 0xb0, MENU_CC, menu]);
  }
  const arrows = arrowBrightness();
  if (sentUp !== arrows.up) {
    sentUp = arrows.up;
    offerLed(ledOut, [0x0b, 0xb0, UP_CC, arrows.up]);
  }
  if (sentDown !== arrows.down) {
    sentDown = arrows.down;
    offerLed(ledOut, [0x0b, 0xb0, DOWN_CC, arrows.down]);
  }
  const place = screenPlace(session.ui);
  trackLeds(session.project, place.context, place.page).forEach((led, index) => {
    const color = ledColorAt(led, now, tempo);
    if (sentTracks[index] === color) return;
    sentTracks[index] = color;
    offerLed(ledOut, [0x0b, 0xb0, TRACK_CC + index, color]);
  });
  padLeds(session.project, session.ui.mode, session.ui, tick).forEach((led, index) => {
    const note = 68 + index;
    const packets = padPackets(note, led);
    const key = ledPacketKey(led);
    if (sentPads[index] !== key) {
      sentPads[index] = key;
      padQueue.set(note, packets);
    }
    const queued = padQueue.get(note);
    if (!queued?.length) return;
    offerLed(ledOut, queued[0]);
    if (queued[0][1] === 0x90) dropLed(ledOut, 0x99, note);
  });
  const play = playLed(session.playing);
  if (sentPlay !== play) {
    sentPlay = play;
    offerLed(ledOut, [0x0b, 0xb0, PLAY_CC, play]);
  }
  const mute = faceButtonLed(session.ui.face, session.ui.faceLatch, session.ui.faceHeld, "mixer");
  if (sentMute !== mute) {
    sentMute = mute;
    offerLed(ledOut, [0x0b, 0xb0, MUTE_CC, mute]);
  }
  const capture = faceButtonLed(session.ui.face, session.ui.faceLatch, session.ui.faceHeld, "deck");
  if (sentCapture !== capture) {
    sentCapture = capture;
    offerLed(ledOut, [0x0b, 0xb0, CAPTURE_CC, capture]);
  }
  const sample = modeButtonLed(session.ui.sampleHeld || session.ui.sampleLatched);
  if (sentSample !== sample) {
    sentSample = sample;
    offerLed(ledOut, [0x0b, 0xb0, SAMPLE_CC, sample]);
  }
}

function paintPulseClock(): void {
  const host = globalThis as HostGlobals;
  if (!host.move_midi_internal_send) return;
  const next = advancePulseClock(pulseClock, Date.now(), session.project.global.tempo);
  pulseClock = next.state;
  pendingClocks.push(...next.packets);
}

function drainLeds(): void {
  const host = globalThis as HostGlobals;
  if (!host.move_midi_internal_send) return;
  let budget = LED_BUDGET;
  while (pendingClocks.length > 0 && budget > 0) {
    host.move_midi_internal_send(pendingClocks.shift() as number[]);
    budget--;
  }
  for (const packet of takeLeds(ledOut, budget)) {
    host.move_midi_internal_send(packet);
    const note = packet[2];
    const queued = padQueue.get(note);
    const head = queued?.[0];
    if (!head || head[1] !== packet[1] || head[3] !== packet[3]) continue;
    queued.shift();
    if (!queued.length) {
      padQueue.delete(note);
      continue;
    }
    offerLed(ledOut, queued[0]);
    if (queued[0][1] === 0x90) dropLed(ledOut, 0x99, note);
  }
}

function ledPacketKey(led: { color: number; blink: boolean; blinkTo?: number }): number {
  return (led.color & 255) | ((led.blink ? 1 : 0) << 8) | (((led.blinkTo ?? 0) & 255) << 16);
}

function paint(): void {
  paintPulseClock();
  const now = Date.now();
  if (bankCovered()) {
    deckFastLatched = false;
    deckCoverKey = "";
    mixerFastLatched = false;
    paintScreen();
  } else if (deckVisible(session.ui) && !deckOverlay(session.ui, now)) {
    mixerFastLatched = false;
    if (deckCoverKey !== "") {
      deckFastLatched = false;
      resetWaveScroll();
    }
    deckCoverKey = "";
    paintDeckFast(now);
  } else if (deckVisible(session.ui)) {
    mixerFastLatched = false;
    paintDeckCovered(now);
  } else if (session.ui.face === "mixer" && !mixerCovered(session.ui, now)) {
    deckFastLatched = false;
    deckCoverKey = "";
    paintMixerFast(now);
  } else {
    deckFastLatched = false;
    deckCoverKey = "";
    mixerFastLatched = false;
    const delta = screenDelta(now);
    if (delta === "full") paintScreen();
    else if (delta === "viz") paintViz(now, true);
    else if (delta === "readout") paintReadout(now);
    else if (delta === "caption") paintCaption(now);
    else if (delta === "head") {
      const moved = nudgePlayhead(frame, session.tick);
      if (moved.kind === "repaint") paintViz(now, false);
      else if (moved.kind === "moved") blitColumns(frame, moved.xs, moved.y0, moved.y1);
    }
  }
  if (ledsDue()) {
    const gates = currentGates();
    if (ledsChanged(gates)) paintLeds(gates);
  }
}

function advanceClock(): void {
  const now = Date.now();
  if (!clockMs) clockMs = now;
  const elapsed = now - clockMs;
  clockMs = now;
  /* A knob scrub blocks this thread while the voice keeps running. Dropping
   * the gap leaves the playhead bars behind the chords. A clock jump past
   * half a minute is ignored so a time discontinuity does not fast-forward. */
  const dt = elapsed < 0 || elapsed > 30000 ? 0 : elapsed;
  const starting = session.playing && !voiceOn;
  if (starting) session = { ...session, tick: 0 };
  else if (session.playing && dt > 0) {
    const samplesPerTick = (SAMPLE_RATE * 60) / (session.project.global.tempo * 192);
    session = { ...session, tick: session.tick + (dt / 1000) * SAMPLE_RATE / samplesPerTick };
  }
  const before = session.project;
  const journalPage = clampJournalPage(session.ui.journalPage, session.project.journal.length);
  const candidates = session.project.wander
    ? wanderCandidates(session.project, session.ui.mode, journalPage)
    : undefined;
  const project = advance(session.project, session.tick, candidates);
  if (project !== before) session = { ...session, project };
  markDirty(before);
  syncVoice(starting);
}

export function init(): void {
  session = boot();
  resetLatch();
  voiceOn = false;
  phraseProject = null;
  phraseBody = "";
  sent.phrase = "";
  sent.gain = "";
  sent.deck = "";
  phraseLatch = "";
  paintLatch = "";
  voiceStep = -1;
  voiceMorph = false;
  clockMs = Date.now();
  sentMs = 0;
  projectDirty = false;
  dirtySinceMs = 0;
  sentSteps = [];
  sentPads = [];
  ledOut.clear();
  padQueue.clear();
  pendingClocks.length = 0;
  sentTracks = [];
  sentMenu = -1;
  sentPlay = -1;
  sentMute = -1;
  sentCapture = -1;
  sentSample = -1;
  sentUp = -1;
  sentDown = -1;
  paintProject = null;
  paintUi = null;
  paintPlaying = false;
  paintNotice = false;
  paintHint = false;
  paintCapture = false;
  paintFocus = false;
  paintPeek = null;
  paintTitleKey = -1;
  paintLane = null;
  paintDigits = "";
  resetWaveform();
  ledPhase = -1;
  ledShade = -1;
  ledLamps = "";
  deckFastLatched = false;
  mixerFastLatched = false;
  mixerMeterText = null;
  deckColumn = Number.NaN;
  deckSpan = Number.NaN;
  deckTape = null;
  chromeDeck = null;
  chromeFocus = false;
  chromeFocusPath = "";
  chromeGesture = "";
  chromeWidth = -2;
  chromeBar = Number.NaN;
  deckCoverKey = "";
  gateProject = null;
  gateStep = Number.NaN;
  gateList = LANES.map(() => 0);
  ledProject = null;
  ledUi = null;
  ledPlaying = false;
  ledPeek = null;
  pulseClock = PULSE_CLOCK_IDLE;
  bank = { phase: "off", percent: 0 };
  bankDismissed = false;
  bankAt = 0;
  const host = globalThis as HostGlobals;
  host.set_font?.(MODULE_FONT);
  syncVoice(true);
  pollBank(true);
  paint();
}

export function tick(): void {
  const now = Date.now();
  pollBank(false);
  pollAudioLoad(now);
  settleLatch(now);
  advanceClock();
  const wheeled = settleWheel(session.ui);
  let next = wheeled === session.ui ? session : { ...session, ui: wheeled };
  next = settleTrackPeek(next, now);
  if (next !== session) session = next;
  maybeAutosave();
  paint();
  drainLeds();
}

export function onMidiMessageExternal(data: number[]): void {
  if (!data || data.length < 3) return;
  const status = data[0] ?? 0;
  const type = status & 0xf0;
  const channel = status & 0x0f;
  const data1 = data[1] ?? 0;
  const data2 = data[2] ?? 0;
  const now = Date.now();
  if (type === 0xb0 && (data1 === 120 || data1 === 123)) releaseChannel(channel, now);
  else if (type === 0x90 || type === 0x80) holdNote(channel, data1, type === 0x80 ? 0 : data2, now);
}

export function onMidiMessageInternal(data: number[]): void {
  if (bank.phase === "fail" && !bankDismissed) bankDismissed = true;
  const msg = midiMessage(data[0] ?? 0, data[1] ?? 0, data[2] ?? 0);
  if (!msg) return;
  const before = session.project;
  const beforeUi = session.ui;
  const beforePlaying = session.playing;
  session = reduce(session, msg);
  markDirty(before);
  if (
    session.ui.context !== beforeUi.context ||
    session.ui.page !== beforeUi.page ||
    session.ui.mode !== beforeUi.mode ||
    session.playing !== beforePlaying ||
    session.ui.sampleLatched !== beforeUi.sampleLatched ||
    (session.ui.randomizeParked ?? session.ui.randomizeLatched) !== (beforeUi.randomizeParked ?? beforeUi.randomizeLatched) ||
    session.ui.faceLatch !== beforeUi.faceLatch ||
    session.ui.deckLayer !== beforeUi.deckLayer
  ) {
    projectDirty = true;
    dirtySinceMs = Date.now();
  }
  if (session.project !== before || deckEdge(beforeUi, session.ui)) syncVoice(false);
  paint();
}

export function onUnload(): void {
  flushSave();
}

const root = globalThis as HostGlobals & {
  init?: () => void;
  tick?: () => void;
  onMidiMessageInternal?: (data: number[]) => void;
  onMidiMessageExternal?: (data: number[]) => void;
  onUnload?: () => void;
};
root.init = init;
root.tick = tick;
root.onMidiMessageInternal = onMidiMessageInternal;
root.onMidiMessageExternal = onMidiMessageExternal;
root.onUnload = onUnload;
