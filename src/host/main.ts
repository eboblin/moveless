import { SAMPLE_RATE } from "../core/clock.ts";
import { defaultProject } from "../core/defaults.ts";
import { holdNote, latchStamp, releaseChannel, resetLatch, settleLatch } from "../core/latch.ts";
import { advance, clampJournalPage, heardFx, journalPageCount, wanderCandidates } from "../core/performance.ts";
import { generatePhrase } from "../core/phrase.ts";
import { loadStoredProject, saveStoredProject, type HostFiles, type StoredUi } from "../core/persist.ts";
import { phraseLoop, soundMotions } from "../dsp/schedule.ts";
import { formatFx } from "../dsp/fx.ts";
import { packPhraseBody } from "../dsp/voice.ts";
import { reduce, type MidiMsg, type Session } from "../ui/input.ts";
import { CAPTURE_CC, DOWN_CC, MENU_CC, MUTE_CC, PLAY_CC, UP_CC } from "../core/types.ts";
import { advancePulseClock, blinkHalfMs, directionLit, dropLed, ledColorAt, menuLed, modeButtonLed, offerLed, padBlinkSteps, padLeds, padPackets, playLed, PULSE_CLOCK_IDLE, stepLeds, takeLeds, trackLeds, type PulseClock } from "../ui/leds.ts";
import { plotAmount, plotMinus } from "../ui/digits.ts";
import {
  CHAR_W,
  DIGIT_Y,
  FONT_H,
  HEADER_H,
  HEIGHT,
  PARAM_COL_W,
  WIDTH,
  VIZ_H,
  cellTextX,
  renderScreen,
} from "../ui/screen.ts";
import { defaultUi, focusVisible, peekKind, rememberPage, settleWheel, type UiState } from "../ui/state.ts";
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
  shadow_set_param?: (slot: number, key: string, value: string) => void;
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
  return { context: session.ui.context, page: session.ui.page, mode: session.ui.mode, playing: session.playing };
}

function boot(): Session {
  const stored = loadStoredProject(hostFiles());
  if (!stored) return { project: defaultProject(), ui: defaultUi(), tick: 0, playing: true };
  return {
    project: stored.project,
    ui: { ...rememberPage(defaultUi(), stored.ui.context, stored.ui.page), mode: stored.ui.mode },
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
let phraseLatch = "";
let voiceStep = -1;
let voiceMorph = false;
let projectDirty = false;
let dirtySinceMs = 0;

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
    return;
  }
  const step = Math.floor(session.tick / 48);
  const morphing = session.project.morph !== null;
  const boundary = morphing !== voiceMorph || step !== voiceStep;
  const latch = Math.round(session.project.progression.count) <= 0 ? latchStamp() : "";
  const latchChanged = latch !== phraseLatch;
  if ((phraseProject !== session.project && (!morphing || boundary || reset)) || latchChanged) {
    const phrase = generatePhrase(session.project);
    phraseBody = packPhraseBody(phraseLoop(session.project, phrase), soundMotions(session.project, phrase), formatFx(heardFx(session.project), session.project.global.bar));
    phraseProject = session.project;
    phraseSent = "";
    phraseLatch = latch;
  }
  voiceStep = step;
  voiceMorph = morphing;
  const now = Date.now();
  if (reset || phraseSent !== phraseBody || now - sentMs > 400) {
    sendBlock(`P|${tempo}|${reset ? 1 : 0}|${phraseBody}`);
    phraseSent = phraseBody;
    sentMs = now;
  }
  voiceOn = true;
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
/** Last channel-0 colour handed to the device, per pad index. */
const latchedPad: Array<number | null> = [];
/** Last channel-0 colour handed to a step button. */
const latchedStep: Array<number | null> = [];
const pendingClocks: number[][] = [];
const LED_BUDGET = 16;
let sentTracks: number[] = [];
let sentMenu = -1;
let sentPlay = -1;
let sentMute = -1;
let sentCapture = -1;
let sentUp = -1;
let sentDown = -1;
const TRACK_CC = 40;
const frame = new Uint8Array(WIDTH * HEIGHT);
let paintProject: Project | null = null;
let paintUi: UiState | null = null;
let paintPlaying = false;
let paintStep = -1;
let paintLatch = "";
let paintNotice = false;
let paintHint = false;
let paintFocus = false;
let paintPeek: string | null = null;
let ledPhase = -1;
let ledProject: Project | null = null;
let ledUi: UiState | null = null;
let ledPlaying = false;
let ledPeek: string | null = null;
let pulseClock: PulseClock = PULSE_CLOCK_IDLE;

function screenChanged(): boolean {
  const ui = session.ui;
  const step = Math.floor(Math.max(0, session.tick) / 48);
  const now = Date.now();
  const notice = !!(ui.notice && now < ui.notice.untilMs);
  const hint = !!(ui.randomizeHint && now < ui.randomizeHint.untilMs);
  const focus = focusVisible(ui.focus, session.tick, now);
  const peek = peekKind(ui);
  const latch = Math.round(session.project.progression.count) <= 0 ? latchStamp() : "";
  if (
    paintProject === session.project &&
    paintUi === ui &&
    paintPlaying === session.playing &&
    paintStep === step &&
    paintNotice === notice &&
    paintHint === hint &&
    paintFocus === focus &&
    paintPeek === peek &&
    paintLatch === latch
  ) {
    return false;
  }
  paintProject = session.project;
  paintUi = ui;
  paintPlaying = session.playing;
  paintStep = step;
  paintNotice = notice;
  paintHint = hint;
  paintFocus = focus;
  paintPeek = peek;
  paintLatch = latch;
  return true;
}

function ledsChanged(): boolean {
  const phase = Math.floor(Date.now() / blinkHalfMs(session.project.global.tempo));
  const peek = peekKind(session.ui);
  if (ledPhase === phase && ledProject === session.project && ledUi === session.ui && ledPlaying === session.playing && ledPeek === peek) return false;
  ledPhase = phase;
  ledProject = session.project;
  ledUi = session.ui;
  ledPlaying = session.playing;
  ledPeek = peek;
  return true;
}

function paintScreen(): void {
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing, Date.now(), frame);
  blit(screen.pixels);
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
    plotAmount(digit.cell * PARAM_COL_W, PARAM_COL_W, DIGIT_Y, digit.amount, (x, y) => {
      host.set_pixel?.(x, y, color);
    });
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
}

function arrowBrightness(): { up: number; down: number } {
  if (session.ui.mode === "set") {
    const index = session.project.sets.findIndex((set) => set.id === session.project.activeSetId);
    return directionLit(Math.max(0, index), session.project.sets.length);
  }
  const count = journalPageCount(session.project.journal.length);
  return directionLit(clampJournalPage(session.ui.journalPage, session.project.journal.length), count);
}

function paintLeds(): void {
  const host = globalThis as HostGlobals;
  if (!host.move_midi_internal_send) return;
  const now = Date.now();
  const tempo = session.project.global.tempo;
  const tick = session.tick;
  stepLeds(session.project, session.ui.context).forEach((led, index) => {
    const note = 16 + index;
    const key = padPackets(note, led).map((packet) => packet.join(",")).join(";");
    if (sentSteps[index] !== key) {
      sentSteps[index] = key;
      padQueue.set(note, padBlinkSteps(note, led, latchedStep[index] ?? null));
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
  trackLeds(session.project, session.ui.context, session.ui.page).forEach((led, index) => {
    const color = ledColorAt(led, now, tempo);
    if (sentTracks[index] === color) return;
    sentTracks[index] = color;
    offerLed(ledOut, [0x0b, 0xb0, TRACK_CC + index, color]);
  });
  padLeds(session.project, session.ui.mode, session.ui, tick).forEach((led, index) => {
    const note = 68 + index;
    const key = padPackets(note, led).map((packet) => packet.join(",")).join(";");
    if (sentPads[index] !== key) {
      sentPads[index] = key;
      padQueue.set(note, padBlinkSteps(note, led, latchedPad[index] ?? null));
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
  const mute = modeButtonLed(session.ui.muteHeld || session.ui.muteLatched);
  if (sentMute !== mute) {
    sentMute = mute;
    offerLed(ledOut, [0x0b, 0xb0, MUTE_CC, mute]);
  }
  const capture = modeButtonLed(session.ui.captureHeld || session.ui.captureLatched);
  if (sentCapture !== capture) {
    sentCapture = capture;
    offerLed(ledOut, [0x0b, 0xb0, CAPTURE_CC, capture]);
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
    if (packet[1] === 0x90 && note >= 16 && note <= 31) latchedStep[note - 16] = packet[3];
    if (packet[1] === 0x90 && note >= 68 && note <= 99) latchedPad[note - 68] = packet[3];
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
  if (screenChanged()) paintScreen();
  if (ledsChanged()) paintLeds();
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
  latchedPad.length = 0;
  latchedStep.length = 0;
  pendingClocks.length = 0;
  sentTracks = [];
  sentMenu = -1;
  sentPlay = -1;
  sentMute = -1;
  sentCapture = -1;
  sentUp = -1;
  sentDown = -1;
  paintProject = null;
  paintUi = null;
  paintPlaying = false;
  paintStep = -1;
  paintNotice = false;
  paintHint = false;
  paintFocus = false;
  paintPeek = null;
  ledPhase = -1;
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
  settleLatch(Date.now());
  advanceClock();
  const ui = settleWheel(session.ui);
  if (ui !== session.ui) session = { ...session, ui };
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
  const status = data[0] ?? 0;
  const hi = status & 0xf0;
  const kind: MidiMsg["kind"] = hi === 0x90 || hi === 0x80 ? "note" : "cc";
  const data2 = hi === 0x80 ? 0 : (data[2] ?? 0);
  const before = session.project;
  const beforeUi = session.ui;
  const beforePlaying = session.playing;
  session = reduce(session, { kind, data1: data[1] ?? 0, data2 });
  markDirty(before);
  if (
    session.ui.context !== beforeUi.context ||
    session.ui.page !== beforeUi.page ||
    session.ui.mode !== beforeUi.mode ||
    session.playing !== beforePlaying
  ) {
    projectDirty = true;
    dirtySinceMs = Date.now();
  }
  if (session.project !== before) syncVoice(false);
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
