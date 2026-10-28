import { SAMPLE_RATE, SIXTEENTH_TICKS } from "../core/clock.ts";
import { defaultProject } from "../core/defaults.ts";
import { holdNote, latchStamp, releaseChannel, resetLatch, settleLatch } from "../core/latch.ts";
import { advance, clampJournalPage, heardFx, journalPageCount, sameHeard, wanderCandidates } from "../core/performance.ts";
import { generatePhrase, lanePattern } from "../core/phrase.ts";
import { loadStoredProject, saveStoredProject, type HostFiles, type StoredUi } from "../core/persist.ts";
import { phraseLoop, soundMotions } from "../dsp/schedule.ts";
import { formatFx } from "../dsp/fx.ts";
import { assembleDeck, behaviorOf, formatDeckCommand, isDeckGroup } from "../core/deck.ts";
import { formatBus, packPhraseBody, parseMeterPage } from "../dsp/voice.ts";
import { midiMessage, reduce, settleTrackPeek, type Session } from "../ui/input.ts";
import { CAPTURE_CC, DOWN_CC, LANES, MENU_CC, MUTE_CC, PLAY_CC, SAMPLE_CC, UP_CC } from "../core/types.ts";
import { advancePulseClock, blinkHalfMs, directionLit, dropLed, faceButtonLed, ledColorAt, menuLed, modeButtonLed, offerLed, padLeds, padPackets, playLed, PULSE_CLOCK_IDLE, sceneShadeStep, stepLampKey, stepLeds, takeLeds, trackLeds, type PulseClock } from "../ui/leds.ts";
import { plotAmount, plotMinus } from "../ui/digits.ts";
import {
  CHAR_W,
  DIGIT_Y,
  FONT_H,
  HEADER_H,
  HEIGHT,
  PARAM_COL_W,
  MIX_METER_BOTTOM,
  MIX_METER_TOP,
  MIX_METER_X,
  SEP_Y,
  WIDTH,
  VIZ_H,
  cellTextX,
  deckFrame,
  loadWidth,
  nudgePlayhead,
  pageTitlePaintKey,
  pageTitleVisible,
  renderScreen,
  type Screen,
} from "../ui/screen.ts";
import { resetWaveform, serviceWaveform } from "../ui/wave-audio.ts";
import { applyWavePages, strokeWaveform, type WaveTape } from "../ui/wave.ts";
import { defaultUi, focusVisible, peekKind, rememberPage, screenPlace, settleWheel, type UiState } from "../ui/state.ts";
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
const MODULE_FONT = "/data/UserData/schwung/modules/overtake/ptnmove/font.png";
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
  };
}

function boot(): Session {
  const stored = loadStoredProject(hostFiles());
  if (!stored) return { project: defaultProject(), ui: defaultUi(), tick: 0, playing: true };
  return {
    project: stored.project,
    ui: {
      ...rememberPage(defaultUi(), stored.ui.context, stored.ui.page),
      mode: stored.ui.mode,
      sampleLatched: stored.ui.sampleLatched,
    },
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
let phraseSent = "";
let deckSent = "";
let phraseLatch = "";
let voiceStep = -1;
let voiceMorph = false;
let projectDirty = false;
let dirtySinceMs = 0;
/** Last audio-frame load drawn, after the glide toward the dsp.so reading. */
let audioLoad = 0;
let audioLoadAt = 0;
let targetLoad = 0;
let shownLoad = 0;
let shownAt = 0;
let shownWidth = -1;
/** Glide so a new reading moves the line instead of jumping it. */
const LOAD_TAU_MS = 450;

function pollAudioLoad(now: number): void {
  if (now - audioLoadAt >= 100) {
    audioLoadAt = now;
    const host = globalThis as HostGlobals;
    const raw = host.host_module_get_param?.("cpu") ?? host.shadow_get_param?.(0, "overtake_dsp:cpu");
    if (typeof raw === "string") {
      const n = Number.parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 0 && n <= 99) targetLoad = n;
    }
  }
  const dt = shownAt === 0 ? 0 : Math.max(0, Math.min(50, now - shownAt));
  shownAt = now;
  if (dt > 0) shownLoad += (targetLoad - shownLoad) * (1 - Math.exp(-dt / LOAD_TAU_MS));
  const width = loadWidth(shownLoad);
  if (width === shownWidth) return;
  shownWidth = width;
  audioLoad = shownLoad;
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
    phraseSent = "";
    deckSent = "";
    return;
  }
  const step = Math.floor(session.tick / 48);
  const morphing = session.project.morph !== null;
  const boundary = morphing !== voiceMorph || step !== voiceStep;
  const latch = Math.round(session.project.progression.count) <= 0 ? latchStamp() : "";
  const latchChanged = latch !== phraseLatch;
  const heardSame = phraseProject !== null && sameHeard(phraseProject, session.project);
  if ((!heardSame && (!morphing || boundary || reset)) || latchChanged) {
    const phrase = generatePhrase(session.project);
    phraseBody = packPhraseBody(
      phraseLoop(session.project, phrase),
      soundMotions(session.project, phrase),
      formatFx(heardFx(session.project), session.project.global.bar),
      formatBus(session.project.bus),
    );
    phraseProject = session.project;
    phraseSent = "";
    phraseLatch = latch;
  }
  voiceStep = step;
  voiceMorph = morphing;
  const now = Date.now();
  const deck = deckCommand();
  const sameBody = !reset && phraseBody.length > 0 && phraseSent === phraseBody;
  const phraseDue = reset || phraseSent !== phraseBody || now - sentMs > 400;
  if (phraseDue) {
    sendBlock(sameBody ? `K|${tempo}` : `P|${tempo}|${reset ? 1 : 0}|${phraseBody}`);
    if (!sameBody) phraseSent = phraseBody;
    sentMs = now;
  }
  if (phraseDue || deck !== deckSent) {
    sendBlock(deck);
    deckSent = deck;
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
    host.set_pixel(i % 128, Math.floor(i / 128), 1);
  }
}

let sentSteps: string[] = [];
let sentPads: string[] = [];
/** Unsent LED MIDI. Drained a block at a time so a full repaint is not dropped. */
const ledOut = new Map<number, number[]>();
/** Pad packets still owed, one per drain, so a pulse arms after its colour has latched. */
const padQueue = new Map<number, number[][]>();
const pendingClocks: number[][] = [];
const LED_BUDGET = 16;
let sentTracks: number[] = [];
let sentMenu = -1;
let sentPlay = -1;
let sentMute = -1;
let sentCapture = -1;
let sentSample = -1;
let sentUp = -1;
let sentDown = -1;
const TRACK_CC = 40;
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
let paintDeckFrame = -1;
let paintTitleKey = -1;
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
let chromeUi: UiState | null = null;
let chromeFocus = false;
let chromeWidth = -2;
let chromeBar = Number.NaN;
let pulseClock: PulseClock = PULSE_CLOCK_IDLE;

function blitColumns(pixels: Uint8Array, xs: readonly number[], y0: number, y1: number): void {
  const pixel = (globalThis as HostGlobals).set_pixel;
  if (!pixel) return;
  for (const x of xs) {
    if (x < 0 || x >= WIDTH) continue;
    for (let y = y0; y <= y1; y++) pixel(x, y, pixels[y * WIDTH + x] ? 1 : 0);
  }
}

function screenDelta(): "same" | "full" | "head" {
  const ui = session.ui;
  const now = Date.now();
  const notice = !!(ui.notice && now < ui.notice.untilMs);
  const hint = !!(ui.randomizeHint && now < ui.randomizeHint.untilMs);
  const capture = !!(ui.sampleHint && now < ui.sampleHint.untilMs);
  const focus = focusVisible(ui.focus, session.tick, now);
  const peek = peekKind(ui);
  const latch = Math.round(session.project.progression.count) <= 0 ? latchStamp() : "";
  const deckFrame = deckVisible(ui) ? Math.floor(Math.max(0, session.tick)) : -1;
  const titleKey = pageTitlePaintKey(ui, now);
  const pictureSame = paintProject === session.project
    && paintUi === ui
    && paintPlaying === session.playing
    && paintNotice === notice
    && paintHint === hint
    && paintCapture === capture
    && paintFocus === focus
    && paintPeek === peek
    && paintLatch === latch
    && paintDeckFrame === deckFrame
    && paintLoad === audioLoad
    && paintTitleKey === titleKey;
  if (pictureSame) {
    if (!session.playing || deckVisible(ui)) return "same";
    return "head";
  }
  paintProject = session.project;
  paintUi = ui;
  paintPlaying = session.playing;
  paintNotice = notice;
  paintHint = hint;
  paintCapture = capture;
  paintFocus = focus;
  paintPeek = peek;
  paintLatch = latch;
  paintDeckFrame = deckFrame;
  paintLoad = audioLoad;
  paintTitleKey = titleKey;
  return "full";
}

function laneGates(): readonly number[] {
  const step = session.playing ? Math.max(0, session.tick) / SIXTEENTH_TICKS : -1;
  return LANES.map((lane) => (step < 0 ? 0 : lanePattern(session.project, lane, step)));
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
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, Date.now(), frame, audioLoad, wave, mixerMeters());
  blit(screen.pixels);
  paintHostReadout(screen);
}

/** Faders stay. Only the eight level columns move. */
function paintMixerFast(now: number): void {
  const text = readParam("meters");
  const delta = screenDelta();
  if (delta === "full" || !mixerFastLatched) {
    paintScreen();
    mixerFastLatched = true;
    mixerMeterText = text;
    return;
  }
  if (text === mixerMeterText) return;
  mixerMeterText = text;
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, now, frame, audioLoad, null, parseMeterPage(text));
  blitColumns(screen.pixels, MIX_METER_X, MIX_METER_TOP, MIX_METER_BOTTOM);
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
  return chromeDeck !== session.project.deck
    || chromeUi !== session.ui
    || chromeFocus !== focusVisible(session.ui.focus, session.tick, now)
    || chromeWidth !== shownWidth
    || chromeBar !== session.project.global.bar;
}

function paintDeckChrome(now: number): void {
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, now, frame, audioLoad, null);
  hostRect(0, 0, WIDTH, HEADER_H, 0);
  blitRows(screen.pixels, 0, HEADER_H);
  hostRect(0, SEP_Y, WIDTH, 1, 1);
  const paramTop = HEADER_H + VIZ_H;
  hostRect(0, paramTop, WIDTH, HEIGHT - paramTop, 0);
  paintHostReadout(screen);
  chromeDeck = session.project.deck;
  chromeUi = session.ui;
  chromeFocus = focusVisible(session.ui.focus, session.tick, now);
  chromeWidth = shownWidth;
  chromeBar = session.project.global.bar;
}

function paintDeckWave(wave: WaveTape, head: number, span: number): void {
  const yTop = HEADER_H;
  const h = VIZ_H - 1;
  hostRect(0, yTop, WIDTH, h, 0);
  const pixel = (globalThis as HostGlobals).set_pixel;
  strokeWaveform(
    wave,
    { x: 0, y: yTop, w: WIDTH, h, head, span, gain: 1, stylus: true },
    hostRect,
    (x, y, value) => pixel?.(x, y, value),
  );
}

/** Platter column and knob readout, each only when that band changed. */
function paintDeckFast(now: number): void {
  const wave = serviceWaveform(session.project);
  applyWavePages(wave, [readParam("wave0"), readParam("wave1")]);
  const picture = deckFrame(session.project, session.ui, session.tick);
  const head = wave.readHead != null ? wave.readHead : picture.head;
  const span = wave.pastSpan > 0 ? wave.pastSpan : picture.span;
  const column = span > 0 ? Math.floor((head * WIDTH) / span) : 0;
  const waveDirty = !deckFastLatched || column !== deckColumn || span !== deckSpan || wave !== deckTape;
  const chromeDirty = !deckFastLatched || deckChromeStale(now);
  if (chromeDirty) paintDeckChrome(now);
  if (waveDirty) paintDeckWave(wave, head, span);
  deckFastLatched = true;
  deckColumn = column;
  deckSpan = span;
  deckTape = wave;
}

function arrowBrightness(): { up: number; down: number } {
  if (session.ui.mode === "set") {
    const index = session.project.sets.findIndex((set) => set.id === session.project.activeSetId);
    return directionLit(Math.max(0, index), session.project.sets.length);
  }
  const count = journalPageCount(session.project.journal.length);
  return directionLit(clampJournalPage(session.ui.journalPage, session.project.journal.length), count);
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
    const key = packets.map((packet) => packet.join(",")).join(";");
    if (sentSteps[index] !== key) {
      sentSteps[index] = key;
      padQueue.set(note, packets);
    }
    const queued = padQueue.get(note);
    if (!queued?.length) return;
    offerLed(ledOut, queued[0]);
    if (queued[0][1] === 0x90) dropLed(ledOut, 0x99, note);
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
    const key = packets.map((packet) => packet.join(",")).join(";");
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

function paint(): void {
  paintPulseClock();
  const now = Date.now();
  if (deckVisible(session.ui) && !deckOverlay(session.ui, now)) {
    mixerFastLatched = false;
    paintDeckFast(now);
  } else if (session.ui.face === "mixer" && !mixerCovered(session.ui, now)) {
    deckFastLatched = false;
    paintMixerFast(now);
  } else {
    deckFastLatched = false;
    mixerFastLatched = false;
    const delta = screenDelta();
    if (delta === "full") paintScreen();
    else if (delta === "head") {
      const moved = nudgePlayhead(frame, session.tick);
      if (moved.kind === "repaint") paintScreen();
      else if (moved.kind === "moved") blitColumns(frame, moved.xs, moved.y0, moved.y1);
    }
  }
  const gates = laneGates();
  if (ledsChanged(gates)) paintLeds(gates);
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
  session = {
    ...session,
    project: advance(session.project, session.tick, wanderCandidates(session.project, session.ui.mode, journalPage)),
  };
  markDirty(before);
  syncVoice(starting);
}

export function init(): void {
  session = boot();
  resetLatch();
  voiceOn = false;
  phraseProject = null;
  phraseBody = "";
  phraseSent = "";
  deckSent = "";
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
  paintDeckFrame = -1;
  paintTitleKey = -1;
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
  chromeUi = null;
  chromeFocus = false;
  chromeWidth = -2;
  chromeBar = Number.NaN;
  ledProject = null;
  ledUi = null;
  ledPlaying = false;
  ledPeek = null;
  pulseClock = PULSE_CLOCK_IDLE;
  const host = globalThis as HostGlobals;
  host.set_font?.(MODULE_FONT);
  syncVoice(true);
  paint();
}

export function tick(): void {
  const now = Date.now();
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
    session.ui.sampleLatched !== beforeUi.sampleLatched
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
