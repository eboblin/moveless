import { GROUP_PAD, DIV_LABEL, BRAKE_LABEL, QUANT_LABEL, assembleDeck, behaviorOf, deckKnobsFor, deckPicture, isDeckGroup, lenLabel, type DeckKnobId, type DeckPicture } from "../core/deck.ts";
import { laneHeard } from "../core/journal.ts";
import { SIXTEENTH_TICKS, countFromUnit, rateFromUnit, tickToSample } from "../core/clock.ts";
import { phraseStepsOf } from "../core/events.ts";
import { chordSymbol, degreeNumeral, pitchClassName, scaleShort, scaleTitle } from "../core/harmony.ts";
import { chordFigure, generatePhrase, laneSteps, octaveNumber, restingChordToneLabel, restingPitchLabel, restingSliceLabel } from "../core/phrase.ts";
import { evalModulated } from "../core/modulate.ts";
import { RANDOMIZE_DEPTHS, RANDOMIZE_INTENSITIES, RANDOMIZE_SCOPES, TRANSITIONS, WANDERS, isPitched, isVoice, LANES, LANE_CODE, type RandomizeDepth, type RandomizeIntensity, type RandomizeScope, type ContextId, type HarmonicEvent, type LaneId, type Phrase, type Project, type TimedEvent } from "../core/types.ts";
import { DIGIT_H, displayAmount, type BigAmount, type DisplayAmount } from "./digits.ts";
import { readControl } from "./controls.ts";
import { bindingFor, deckPage, pagesFor, type Binding, type Page } from "../core/pages.ts";
import { focusVisible, macroReturnValue, peekKind, type CaptureLine, type RandomizeLine, type UiState } from "./state.ts";
import { drawWaveform, emptyWave, type WaveTape } from "./wave.ts";

export const WIDTH = 128;
export const HEIGHT = 64;
/** Typical advance for the bundled 4×5 face (cap body + 1 px gap). */
export const CHAR_W = 5;
export const FONT_H = 5;
export const PARAM_COLS = 8;
export const PARAM_COL_W = WIDTH / PARAM_COLS;
/** Header: title, 1 px gap, the rule, 1 px gap, then viz. */
export const TITLE_Y = 1;
export const PAGER_Y = TITLE_Y + FONT_H + 1;
export const HEADER_H = PAGER_Y + 2;
/** Bottom strip: big digits → 2 px → name → 1 px pad (no meter). */
export const NAME_Y = HEIGHT - FONT_H - 1;
export const DIGIT_Y = NAME_Y - 2 - DIGIT_H;
/** Wide (3+ digit) values: small face centered in the digit band. */
export const VALUE_Y = DIGIT_Y + Math.floor((DIGIT_H - FONT_H) / 2);
/** Viz ends with separator, then 3 px (minus sits in that gap). */
export const VIZ_H = DIGIT_Y - HEADER_H - 3;
export const SEP_Y = HEADER_H + VIZ_H - 1;
export const PARAM_H = HEIGHT - HEADER_H - VIZ_H;

export interface Label {
  x: number;
  y: number;
  text: string;
  invert?: boolean;
  /** Param column 0..7 — paint centers text in this fixed-width cell. */
  cell?: number;
  /** Draw the bipolar minus dash above the digit band. */
  minus?: boolean;
}

/** Big 0..99 value drawn by the host after cell invert. */
export interface DigitCell {
  cell: number;
  amount: BigAmount;
  invert: boolean;
}

export interface Screen {
  header: string;
  viz: string;
  pixels: Uint8Array;
  labels: Label[];
  digits: DigitCell[];
  /** Knob columns whose gesture is not using them. The host punches a checker through the cell. */
  dim: number[];
}

/** Lit pixels of the 1 px load bar. 0 is empty, 99 fills the width. */
export function loadWidth(load: number): number {
  const n = Math.max(0, Math.min(99, Math.floor(Number.isFinite(load) ? load : 0)));
  if (n <= 0) return 0;
  return Math.max(1, Math.round((n / 99) * WIDTH));
}

export function renderScreen(
  project: Project,
  ui: UiState,
  tick: number,
  playing = false,
  now = Date.now(),
  pixels: Uint8Array = new Uint8Array(WIDTH * HEIGHT),
  cpu = 0,
  wave: WaveTape | null = null,
): Screen {
  const peek = ui.heldContext;
  const context = peek ?? ui.context;
  const pageIndex = peek ? ui.heldPage ?? ui.lanePages[peek] ?? 0 : ui.page;
  const pages = pagesFor(context);
  const page = pages[Math.min(pageIndex, pages.length - 1)];
  const kind = peekKind(ui);
  const notice = ui.notice && now < ui.notice.untilMs ? ui.notice : null;
  const randomize = ui.randomizeHint && now < ui.randomizeHint.untilMs ? ui.randomizeHint : null;
  const capture = ui.captureHint && now < ui.captureHint.untilMs ? ui.captureHint : null;
  const hint = !randomize ? capture : !capture ? randomize : capture.untilMs >= randomize.untilMs ? capture : randomize;
  const focusState = !notice && focusVisible(ui.focus, tick, now) ? ui.focus : null;
  const focus = focusState?.label ?? null;
  const focusBinding = focusState ? bindingFor(focusState.path) : null;
  const mixer = !notice && kind === "mute";
  const decking = !notice && kind === "deck";
  const heard = ui.deckGesture ?? ui.deckLatchedGesture;
  const deckTitle = GROUP_PAD.find((pad) => pad.id === heard)?.title ?? "DECK";
  const header = mixer
    ? (focusBinding?.title ?? focus ?? "MIXER")
    : decking
      ? (focusBinding?.title ?? focus ?? deckTitle)
    : (focusBinding ? figureHeader(project, context, focusBinding) : null) ??
      focusBinding?.title ??
      (focus ? focus : laneHeader(project, context, page));
  const vizLane: LaneId | null = isVoice(context) ? context : null;
  const generator = vizLane && focusState?.generator ? focusState.generator : null;
  const bars = !notice && !mixer && !decking && page?.id === "prog";
  const viz = notice ? "notice" : mixer ? "mixer" : decking ? "deck" : generator ? "generator" : vizLane || bars ? "phrase" : "none";
  pixels.fill(0);
  const laneMark = (LANES as readonly ContextId[]).indexOf(context);
  const pageMark = mixer ? laneMark : Math.min(pageIndex, Math.max(0, pages.length - 1));
  const pageCount = mixer ? MIX_CHANNELS.length : pages.length;
  if (ui.wheelTouch) drawPager(pixels, pageMark, pageCount);
  else drawLoad(pixels, cpu);
  if (!mixer) drawParamSeparator(pixels);
  const chordRoll = vizLane === "chords";
  const showPhrase = !notice && !mixer && !decking && (vizLane !== null || bars);
  const phrase = showPhrase ? generatePhrase(project) : null;
  const playhead = playing ? stepAt(project, tick) : -1;
  if (notice) fillViz(pixels);
  else if (mixer) drawMixer(pixels, project, focus);
  else if (generator && phrase && vizLane) {
    if (chordRoll) drawChordRoll(pixels, phrase, -1);
    else drawPhrase(pixels, project, phrase, vizLane, -1);
    dimPattern(pixels);
    drawGenerator(pixels, project, context, generator, focusState?.showPattern ?? false, playhead);
  }   else if (bars && phrase) drawChordBars(pixels, phrase, playhead);
  else if (chordRoll && phrase) drawChordRoll(pixels, phrase, playhead);
  else if (vizLane && phrase) drawPhrase(pixels, project, phrase, vizLane, playhead);
  else if (decking) drawDeck(pixels, project, ui, tick, wave);
  const deckFocus = decking && !focus && heard ? deckTitle : focus;
  const deck = decking ? deckPage() : null;
  const labels = mixer
    ? [{ x: 1, y: TITLE_Y, text: header.slice(0, LINE_LIMIT) }, ...mixerChannelLabels(project, focus)]
    : decking
      ? drawLabels(project, context, deck ?? undefined, deckFocus, header, ui, now)
    : drawLabels(project, context, page, focus, header, ui, now);
  const menu = hint && !notice && !mixer ? menuLineLabels(project, hint.line) : null;
  if (phrase && bars) {
    const names = chordNameLabels(project, phrase);
    // Names are host labels, painted after the pixel plate. Drop any that would cover the row.
    labels.push(...(menu ? names.filter((label) => !labelCoversPlate(label, menu)) : names));
  }
  if (notice) labels.push(...noticeLabels(notice.title, notice.value));
  if (menu) {
    clearLinePlate(pixels, menu);
    labels.push(...menu);
  }
  const digits = mixer ? [] : deck ? paramDigits(project, context, deck, focus, ui, now) : !page ? [] : paramDigits(project, context, page, focus, ui, now);
  const dim = decking ? deckDimCells(project, ui) : [];
  return { header, viz, pixels, labels, digits, dim };
}

function fillViz(pixels: Uint8Array): void {
  for (let y = HEADER_H; y < HEADER_H + VIZ_H - 1; y++) {
    for (let x = 0; x < WIDTH; x++) set(pixels, x, y, 1);
  }
}

const MIX_CHANNELS = [...LANES, "master"] as const;
const MIX_COL_W = 16;
/** Bottom strip: mute/lock, 1 px gap, lane code, 1 px pad. */
const MIX_CODE_Y = HEIGHT - FONT_H - 1;
const MIX_MARK_Y = MIX_CODE_Y - FONT_H - 1;
const MIX_FADER_BOTTOM = MIX_MARK_Y - 2;

function mixCode(id: (typeof MIX_CHANNELS)[number]): string {
  return id === "master" ? "MST" : LANE_CODE[id];
}

function mixFocusLabel(id: (typeof MIX_CHANNELS)[number]): string {
  return id === "master" ? "MASTER" : LANE_CODE[id];
}

/** Eight vertical faders; mute/lock then lane codes under the meters. */
function drawMixer(pixels: Uint8Array, project: Project, focus: string | null): void {
  const top = HEADER_H;
  const bottom = MIX_FADER_BOTTOM;
  const trackH = Math.max(1, bottom - top);
  for (let i = 0; i < MIX_CHANNELS.length; i++) {
    const id = MIX_CHANNELS[i];
    const level = Math.max(0, Math.min(1, project.mixer[id]));
    const x0 = i * MIX_COL_W;
    const x1 = x0 + MIX_COL_W - 1;
    const mid = x0 + Math.floor(MIX_COL_W / 2);
    const lit = focus === mixFocusLabel(id);
    const fill = Math.max(0, Math.round(level * trackH));
    for (let y = top; y <= bottom; y++) {
      if (y % 2 === 0) set(pixels, mid, y, 1);
    }
    for (let y = 0; y < fill; y++) {
      const row = bottom - y;
      for (let dx = -1; dx <= 1; dx++) set(pixels, mid + dx, row, 1);
    }
    if (lit) {
      for (let y = top; y <= bottom; y++) {
        set(pixels, x0, y, 1);
        set(pixels, x1, y, 1);
      }
      for (let x = x0; x <= x1; x++) {
        set(pixels, x, top, 1);
        set(pixels, x, bottom, 1);
      }
    }
    if (id !== "master" && !laneHeard(project, id)) {
      for (let y = top; y <= bottom; y++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = mid + dx;
          if ((x + y) % 2 !== 0) set(pixels, x, y, 0);
        }
      }
    }
  }
}

/** Columns a sounding gesture does not read. Empty when every knob is in play. */
function deckDimCells(project: Project, ui: UiState): number[] {
  const heard = ui.deckGesture ?? ui.deckLatchedGesture;
  const keys = deckKnobsFor(heard && isDeckGroup(heard) ? heard : null, project.deck);
  if (!keys) return [];
  const allow = new Set<string>(keys);
  const dim: number[] = [];
  deckPage().bindings.forEach((binding, index) => {
    if (!binding || index >= PARAM_COLS) return;
    const id = binding.path.slice("deck.".length) as DeckKnobId;
    if (!allow.has(id)) dim.push(index);
  });
  return dim;
}

function deckHeardTick(ui: UiState): number | null {
  if (ui.deckGesture) return ui.deckGestureTick;
  if (ui.deckLatchedGesture) return ui.deckLatchTick;
  return null;
}

/** Where the deck strip is looking. The host renders real audio for this window. */
export function deckFrame(project: Project, ui: UiState, tick: number): DeckPicture {
  const tempo = Math.max(1, project.global.tempo);
  const heard = ui.deckGesture ?? ui.deckLatchedGesture;
  const group = heard && isDeckGroup(heard) ? heard : null;
  const motion = deckHeardTick(ui);
  const now = tickToSample(Math.max(0, tick), tempo);
  const down = motion == null ? now : tickToSample(Math.max(0, motion), tempo);
  return deckPicture({
    gesture: group ? behaviorOf(project.deck, group) : null,
    down,
    up: null,
    now,
    tempo,
    barBeats: project.global.bar,
    knobs: group ? assembleDeck(project.deck, group, project.global.bar) : project.deck,
    ahead: 0,
    seed: project.global.seed,
  });
}

/** Platter strip. Ring peaks sit left of the stylus, the phrase collage sits right. The stylus stays at center. */
function drawDeck(pixels: Uint8Array, project: Project, ui: UiState, tick: number, wave: WaveTape | null): void {
  const picture = deckFrame(project, ui, tick);
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  const head = wave?.readHead != null ? wave.readHead : picture.head;
  const span = wave && wave.pastSpan > 0 ? wave.pastSpan : picture.span;
  drawWaveform(pixels, WIDTH, wave ?? emptyWave(), {
    x: 0,
    y: yTop,
    w: WIDTH,
    h: yBottom - yTop + 1,
    head,
    span,
    gain: picture.gain,
    stylus: true,
  });
}

function mixerChannelLabels(project: Project, focus: string | null): Label[] {
  const labels: Label[] = [];
  for (let i = 0; i < MIX_CHANNELS.length; i++) {
    const id = MIX_CHANNELS[i];
    const x0 = i * MIX_COL_W;
    if (id !== "master") {
      const marks = `${project.mute[id] ? "M" : ""}${project.solo[id] ? "S" : ""}${project.lock[id] ? "L" : ""}`;
      if (marks) {
        labels.push({
          x: x0 + Math.max(0, Math.floor((MIX_COL_W - marks.length * CHAR_W) / 2)),
          y: MIX_MARK_Y,
          text: marks,
        });
      }
    }
    const code = mixCode(id);
    labels.push({
      x: x0 + Math.max(0, Math.floor((MIX_COL_W - code.length * CHAR_W) / 2)),
      y: MIX_CODE_Y,
      text: code,
      invert: focus === mixFocusLabel(id),
    });
  }
  return labels;
}

const DEPTH_WORD: Record<RandomizeDepth, string> = { all: "ALL", generators: "GENS", values: "VALUES" };
const SCOPE_WORD: Record<RandomizeScope, string> = { lane: "LANE", group: "GROUP", page: "PAGE" };
const INTENSITY_WORD: Record<RandomizeIntensity, string> = { clear: "DELETE", soft: "LOW", medium: "MED", hard: "HIGH" };
const TRANSITION_WORD: Record<(typeof TRANSITIONS)[number], string> = { now: "NOW", fast: "FAST", medium: "MED", slow: "SLOW" };
const WANDER_WORD: Record<(typeof WANDERS)[number], string> = { fast: "FAST", medium: "MED", slow: "SLOW" };

function randomizeLineLabels(project: Project, line: RandomizeLine): Label[] {
  const y = HEADER_H + Math.floor((VIZ_H - 1 - FONT_H) / 2);
  if (line === "depth") return menuLine(RANDOMIZE_DEPTHS.map((id) => DEPTH_WORD[id]), DEPTH_WORD[project.randomizeDepth], y);
  if (line === "scope") return menuLine(RANDOMIZE_SCOPES.map((id) => SCOPE_WORD[id]), SCOPE_WORD[project.randomizeScope], y);
  return menuLine(RANDOMIZE_INTENSITIES.map((id) => INTENSITY_WORD[id]), INTENSITY_WORD[project.randomizeIntensity], y);
}

function captureLineLabels(project: Project, line: CaptureLine): Label[] {
  const y = HEADER_H + Math.floor((VIZ_H - 1 - FONT_H) / 2);
  if (line === "transition") {
    return menuLine(["TRANS", ...TRANSITIONS.map((id) => TRANSITION_WORD[id])], TRANSITION_WORD[project.transition], y);
  }
  const current = project.wander ? WANDER_WORD[project.wander] : "OFF";
  return menuLine(["WANDER", "OFF", ...WANDERS.map((id) => WANDER_WORD[id])], current, y);
}

function menuLineLabels(project: Project, line: RandomizeLine | CaptureLine): Label[] {
  if (line === "transition" || line === "wander") return captureLineLabels(project, line);
  return randomizeLineLabels(project, line);
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Black plate two pixels outside the whole line, not around each word. */
function linePlate(labels: Label[]): Rect | null {
  if (!labels.length) return null;
  const y = labels[0].y;
  let left = labels[0].x;
  let right = left;
  for (const label of labels) {
    left = Math.min(left, label.x);
    right = Math.max(right, label.x + label.text.length * CHAR_W);
  }
  return {
    x0: Math.max(0, left - 2),
    x1: Math.min(WIDTH, right + 2),
    y0: Math.max(0, y - 2),
    y1: Math.min(HEIGHT, y + FONT_H + 2),
  };
}

function clearLinePlate(pixels: Uint8Array, labels: Label[]): void {
  const plate = linePlate(labels);
  if (!plate) return;
  for (let py = plate.y0; py < plate.y1; py++) {
    for (let px = plate.x0; px < plate.x1; px++) set(pixels, px, py, 0);
  }
}

/** Inverted host text is a box one pixel outside the glyphs. That box must not land on the plate. */
function labelCoversPlate(label: Label, menu: Label[]): boolean {
  const plate = linePlate(menu);
  if (!plate) return false;
  const box: Rect = {
    x0: label.x - 1,
    y0: label.y - 1,
    x1: label.x + label.text.length * CHAR_W + 1,
    y1: label.y + FONT_H + 1,
  };
  return box.x0 < plate.x1 && box.x1 > plate.x0 && box.y0 < plate.y1 && box.y1 > plate.y0;
}

function menuLine(words: string[], current: string, y: number): Label[] {
  const gap = CHAR_W;
  const total = words.reduce((sum, word) => sum + word.length * CHAR_W, 0) + (words.length - 1) * gap;
  let x = Math.max(0, Math.floor((WIDTH - total) / 2));
  return words.map((word) => {
    const label = { x, y, text: word, invert: word === current };
    x += word.length * CHAR_W + gap;
    return label;
  });
}

function noticeLabels(title: string, value: string): Label[] {
  return [
    { x: centered(title), y: HEADER_H + 6, text: title, invert: true },
    { x: centered(value), y: HEADER_H + 18, text: value, invert: true },
  ];
}

function centered(text: string): number {
  return Math.max(0, Math.floor((WIDTH - text.length * CHAR_W) / 2));
}

function laneTag(project: Project, context: ContextId): string {
  let tag = LANE_CODE[context];
  if (context === "aux") return tag;
  if (project.mute[context]) tag += "M";
  if (context !== "fx" && project.solo[context]) tag += "S";
  if (project.lock[context]) tag += "L";
  return tag;
}

function laneHeader(project: Project, context: ContextId, page: Page | undefined): string {
  const tag = laneTag(project, context);
  const [left, right] = page?.groups ?? [page?.title ?? null, null];
  return [tag, left, right].filter(Boolean).join(" ");
}

/** Left-align `text` inside a horizontal half of the header (0 = left, 1 = right). */
export function halfLeftX(half: 0 | 1): number {
  return half * (WIDTH / 2) + 1;
}

/** Right-align `text` against the right edge of the screen. */
export function rightEdgeX(text: string, textWidth = text.length * CHAR_W): number {
  return Math.max(0, WIDTH - textWidth);
}

/** Header rule, one pixel tall. The current page is solid; the others are dotted, with a 1 px gap between pages. */
function drawPager(pixels: Uint8Array, index: number, count: number): void {
  if (count <= 1) {
    for (let x = 0; x < WIDTH; x++) set(pixels, x, PAGER_Y, 1);
    return;
  }
  const gaps = count - 1;
  const area = WIDTH - gaps;
  const edge = (i: number) => Math.floor((i * area) / count);
  let x = 0;
  for (let i = 0; i < count; i++) {
    const width = edge(i + 1) - edge(i);
    for (let p = 0; p < width; p++) {
      if (i === index || p % 2 === 0) set(pixels, x + p, PAGER_Y, 1);
    }
    x += width + 1;
  }
}

/** Dotted rule, with the load drawn solid on top from the left. */
function drawLoad(pixels: Uint8Array, load: number): void {
  const width = loadWidth(load);
  for (let x = 0; x < WIDTH; x++) {
    if (x < width || x % 2 === 0) set(pixels, x, PAGER_Y, 1);
  }
}

/** Solid rule above the knob parameter strip. */
function drawParamSeparator(pixels: Uint8Array): void {
  for (let x = 0; x < WIDTH; x++) set(pixels, x, SEP_Y, 1);
}

/** Darken the phrase with a 1px black checker so a VPCA curve can sit on top. */
function dimPattern(pixels: Uint8Array): void {
  const y1 = HEADER_H + VIZ_H - 2;
  for (let y = HEADER_H; y <= y1; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if ((x + y) % 2 !== 0) set(pixels, x, y, 0);
    }
  }
}

function drawGenerator(pixels: Uint8Array, project: Project, context: ContextId, path: string, showPattern: boolean, playhead: number): void {
  const value = readControl(project, context, `${path}.value`);
  const pattern = readControl(project, context, `${path}.pattern`);
  const cycle = Math.max(1, Math.round(readControl(project, context, `${path}.cycle`)));
  const stored = readControl(project, context, `${path}.amount`);
  const amount = showPattern && stored === 0 ? 1 : stored;
  const lane: LaneId = isVoice(context) ? context : "kick";
  const steps = Math.max(1, laneSteps(project.working, lane, project.global));
  const shown = { value, pattern, cycle, amount };
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  const room = yBottom - yTop + 1;
  const yAt = (step: number) => yBottom - Math.round(evalModulated(shown, step) * (room - 1));
  let previous = yAt(0);
  for (let x = 0; x < WIDTH; x++) {
    const y = yAt((x * steps) / WIDTH);
    const from = Math.min(previous, y);
    const to = Math.max(previous, y);
    for (let row = from; row <= to; row++) set(pixels, x, row, 1);
    previous = y;
  }
  for (let step = 0; step < steps; step += cycle) {
    const x = Math.min(WIDTH - 1, Math.floor((step * WIDTH) / steps));
    set(pixels, x, yTop, 1);
    set(pixels, x, yTop + 1, 1);
  }
  if (playhead >= 0) {
    const pos = ((playhead % steps) + steps) % steps;
    const x = Math.min(WIDTH - 1, Math.floor((pos * WIDTH) / steps));
    for (let y = yTop; y <= yBottom; y++) toggle(pixels, x, y);
  }
}

interface ChordSpan {
  x0: number;
  x1: number;
  event: HarmonicEvent;
}

function chordSpans(events: readonly HarmonicEvent[], steps: number): ChordSpan[] {
  const spans = events.map((event) => {
    const start = event.startTick / SIXTEENTH_TICKS;
    const end = (event.startTick + event.lengthTicks) / SIXTEENTH_TICKS;
    const x0 = Math.min(WIDTH - 1, Math.floor((start * WIDTH) / steps));
    const x1 = Math.min(WIDTH, Math.max(x0 + 1, Math.floor((end * WIDTH) / steps)));
    return { x0, x1, event };
  });
  for (let i = 0; i < spans.length - 1; i++) {
    if (spans[i].x1 - spans[i].x0 > 1) spans[i].x1 -= 1;
  }
  return spans;
}

/** Names and duration blocks. Width is the harmonic length. */
function drawChordBars(pixels: Uint8Array, phrase: Phrase, playhead: number): void {
  const steps = Math.max(1, phrase.steps.chords);
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  for (const span of chordSpans(phrase.harmony, steps)) {
    for (let x = span.x0; x < span.x1; x++) {
      for (let y = yTop; y <= yBottom; y++) set(pixels, x, y, 1);
    }
  }
  if (playhead >= 0) paintPlayhead(pixels, wrapStep(playhead, steps), steps, yTop, yBottom);
}

function chordNameLabels(project: Project, phrase: Phrase): Label[] {
  const steps = Math.max(1, phrase.steps.chords);
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  const stack = FONT_H + 1 + FONT_H;
  const nameY = yTop + Math.max(0, Math.floor((yBottom - yTop + 1 - stack) / 2));
  const degreeY = nameY + FONT_H + 1;
  const labels: Label[] = [];
  for (const span of chordSpans(phrase.harmony, steps)) {
    const width = span.x1 - span.x0;
    const chars = Math.floor(width / CHAR_W);
    if (chars < 1) continue;
    const text = chordSymbol(span.event, project.global).slice(0, chars);
    const textW = text.length * CHAR_W;
    labels.push({
      x: span.x0 + Math.max(0, Math.floor((width - textW) / 2)),
      y: nameY,
      text,
      invert: true,
    });
    const numeral = degreeNumeral(span.event, project.global);
    if (!numeral || numeral.length > chars) continue;
    const numeralW = numeral.length * CHAR_W;
    labels.push({
      x: span.x0 + Math.max(0, Math.floor((width - numeralW) / 2)),
      y: degreeY,
      text: numeral,
      invert: true,
    });
  }
  return labels;
}

/** Piano roll of the notes the chord figure actually plays. */
function drawChordRoll(pixels: Uint8Array, phrase: Phrase, playhead: number): void {
  const steps = Math.max(1, phrase.steps.chords);
  const glyphs = layoutGlyphs(phrase.lanes.chords, steps, true, false);
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  let minNote = glyphs[0]?.event.note ?? 0;
  let maxNote = minNote;
  for (const glyph of glyphs) {
    minNote = Math.min(minNote, glyph.event.note);
    maxNote = Math.max(maxNote, glyph.event.note);
  }
  const yOf = (note: number) => {
    if (maxNote === minNote) return Math.floor((yTop + yBottom) / 2);
    const high = (note - minNote) / (maxNote - minNote);
    return yBottom - Math.round(high * (yBottom - yTop));
  };
  for (const glyph of glyphs) {
    const y = yOf(glyph.event.note);
    paintBar(pixels, glyph.x0, glyph.x1, y, y);
  }
  if (playhead >= 0) paintPlayhead(pixels, wrapStep(playhead, steps), steps, yTop, yBottom);
}

function drawPhrase(pixels: Uint8Array, project: Project, phrase: Phrase, lane: LaneId, playhead: number): void {
  const view = lanePicture(project, phrase, lane, playhead);
  const steps = Math.max(1, view.steps);
  const glyphs = layoutGlyphs(view.events, steps, isPitched(lane), lane !== "chords");
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  const maxEvent = Math.floor(VIZ_H / 2);
  let minNote = glyphs[0]?.event.note ?? 0;
  let maxNote = minNote;
  for (const glyph of glyphs) {
    minNote = Math.min(minNote, glyph.event.note);
    maxNote = Math.max(maxNote, glyph.event.note);
  }
  for (const glyph of glyphs) {
    const event = glyph.event;
    const height = lineHeight(event.velocity, maxEvent);
    const center = pitchCenter(event.note, minNote, maxNote, yTop, yBottom, maxEvent);
    let y0 = Math.round(center - (height - 1) / 2);
    let y1 = y0 + height - 1;
    if (y0 < yTop) {
      y1 += yTop - y0;
      y0 = yTop;
    }
    if (y1 > yBottom) {
      y0 -= y1 - yBottom;
      y1 = yBottom;
    }
    y0 = Math.max(yTop, y0);
    y1 = Math.min(yBottom, y1);
    paintBar(pixels, glyph.x0, glyph.x1, y0, y1);
  }
  if (view.playhead >= 0) paintPlayhead(pixels, wrapStep(view.playhead, steps), steps, yTop, yBottom);
}

/** During a morph the picture is one loop of the live lane, not the chord phrase it rides on. */
function lanePicture(project: Project, phrase: Phrase, lane: LaneId, playhead: number): { steps: number; events: TimedEvent[]; playhead: number } {
  const full = Math.max(1, phrase.steps[lane]);
  const width = patternSteps(project, lane);
  if (width == null || width >= full) return { steps: full, events: phrase.lanes[lane], playhead };
  const cursor = playhead < 0 ? 0 : ((playhead % full) + full) % full;
  const origin = Math.floor(cursor / width) * width;
  const originTick = origin * SIXTEENTH_TICKS;
  const endTick = (origin + width) * SIXTEENTH_TICKS;
  const sliced: TimedEvent[] = [];
  for (const event of phrase.lanes[lane]) {
    if (event.tick < originTick || event.tick >= endTick) continue;
    sliced.push({ ...event, tick: event.tick - originTick });
  }
  return { steps: width, events: sliced, playhead: playhead < 0 ? -1 : cursor - origin };
}

/** Pattern length of the live lane. Chords stay on the shared phrase. */
function patternSteps(project: Project, lane: LaneId): number | null {
  if (!project.morph || lane === "chords") return null;
  const tree = project.working[lane];
  if (!("gen1" in tree)) return null;
  return Math.max(1, phraseStepsOf(tree.gen1, tree.gen2));
}

function paintPlayhead(pixels: Uint8Array, pos: number, steps: number, yTop: number, yBottom: number): void {
  const x = Math.min(WIDTH - 1, Math.floor((pos * WIDTH) / steps));
  for (let y = yTop; y <= yBottom; y++) toggle(pixels, x, y);
}

/** Keep a time inside one lane loop. A ratchet or repeat past the end returns to the start. */
function wrapStep(step: number, steps: number): number {
  return ((step % steps) + steps) % steps;
}

interface Glyph {
  event: TimedEvent;
  /** Onset in pixels, before integer snapping. */
  at: number;
  x0: number;
  /** Lit pixels the event would take with nobody beside it. */
  want: number;
  /** Exclusive end. Past WIDTH the tail paints from the left. */
  x1: number;
}

/**
 * Place every onset on the 128px strip.
 * Simultaneous notes stay on one column (a monophonic lane keeps the loudest).
 * Anything closer than a gap gets pushed apart, borrowing empty columns nearby.
 * A note that would run into the next attack stops one pixel short of it.
 */
function layoutGlyphs(events: TimedEvent[], steps: number, melodic: boolean, collapse: boolean): Glyph[] {
  const source = collapse ? collapseSameOnset(events, steps) : events;
  const glyphs: Glyph[] = source.map((event) => {
    const step = wrapStep(event.tick / SIXTEENTH_TICKS, steps);
    const at = (step / steps) * WIDTH;
    const [x0, x1] = melodic ? noteBounds(step, event.lengthTicks / SIXTEENTH_TICKS, steps) : drumSpan(step, steps);
    return { event, at, x0, want: Math.max(1, x1 - x0), x1 };
  });
  glyphs.sort((a, b) => a.at - b.at || a.x0 - b.x0 || a.event.tick - b.event.tick || a.event.note - b.event.note);
  separateOnsets(glyphs, steps);
  fitWidths(glyphs, melodic);
  return glyphs;
}

/** One column per exact onset. The louder note wins; a later tick breaks a tie. */
function collapseSameOnset(events: TimedEvent[], steps: number): TimedEvent[] {
  const best = new Map<number, TimedEvent>();
  for (const event of events) {
    const key = onsetKey(event, steps);
    const prev = best.get(key);
    if (!prev || event.velocity > prev.velocity || (event.velocity === prev.velocity && event.tick >= prev.tick)) {
      best.set(key, event);
    }
  }
  return [...best.values()];
}

function onsetKey(event: TimedEvent, steps: number): number {
  const loop = steps * SIXTEENTH_TICKS;
  return Math.round(((event.tick % loop) + loop) % loop);
}

/** Runs of onsets that landed on touching columns are opened up inside the free pixels around them. */
function separateOnsets(glyphs: Glyph[], steps: number): void {
  const groups: Array<{ s: number; e: number; x0: number }> = [];
  for (let i = 0; i < glyphs.length;) {
    const key = onsetKey(glyphs[i].event, steps);
    let e = i;
    while (e + 1 < glyphs.length && onsetKey(glyphs[e + 1].event, steps) === key) e++;
    groups.push({ s: i, e, x0: glyphs[i].x0 });
    i = e + 1;
  }
  let g = 0;
  while (g < groups.length) {
    let h = g;
    while (h + 1 < groups.length && groups[h + 1].x0 - groups[h].x0 < 2) h++;
    if (h > g) {
      const starts: number[] = [];
      for (let i = g; i <= h; i++) starts.push(groups[i].x0);
      const lo = g > 0 ? groups[g - 1].x0 + 2 : 0;
      const hi = h + 1 < groups.length ? groups[h + 1].x0 - 2 : WIDTH - 1;
      if (lo <= hi) {
        const placed = openGaps(starts, lo, hi);
        for (let i = g; i <= h; i++) {
          const x0 = placed[i - g];
          for (let k = groups[i].s; k <= groups[i].e; k++) glyphs[k].x0 = x0;
          groups[i].x0 = x0;
        }
      }
    }
    g = h + 1;
  }
}

/**
 * Prefer a 1px mark and a 1px gap. When the window is shorter than that,
 * spend the spare columns as gaps spread across the burst, closest to where the hits were.
 */
function openGaps(starts: number[], lo: number, hi: number): number[] {
  const k = starts.length;
  if (k === 0) return [];
  if (hi < lo) return starts.slice();
  if (k === 1) return [Math.min(hi, Math.max(lo, starts[0]))];
  const room = hi - lo + 1;
  if (room >= (k - 1) * 2 + 1) return spreadStride(starts, 2, lo, hi);
  if (room < k) {
    const last = Math.max(0, room - 1);
    return starts.map((_, i) => lo + Math.floor((i * last) / (k - 1)));
  }
  const gaps = Math.min(k - 1, room - k);
  const block = k + gaps;
  const origin = Math.max(lo, Math.min(starts[0], hi - block + 1));
  const x = new Array<number>(k);
  x[0] = origin;
  for (let i = 0; i < k - 1; i++) {
    const gap = Math.floor(((i + 1) * gaps) / (k - 1)) - Math.floor((i * gaps) / (k - 1));
    x[i + 1] = x[i] + 1 + gap;
  }
  return x;
}

/** Push later hits right until each pair has `stride` columns. If that runs off the edge, pull the burst back. */
function spreadStride(starts: number[], stride: number, lo: number, hi: number): number[] {
  const n = starts.length;
  const x = starts.map((value) => Math.min(hi, Math.max(lo, value)));
  for (let i = 1; i < n; i++) {
    const min = x[i - 1] + stride;
    if (x[i] < min) x[i] = min;
  }
  if (x[n - 1] > hi) {
    x[n - 1] = hi;
    for (let i = n - 2; i >= 0; i--) {
      const max = x[i + 1] - stride;
      if (x[i] > max) x[i] = max;
    }
  }
  if (x[0] < lo) {
    x[0] = lo;
    for (let i = 1; i < n; i++) {
      const min = x[i - 1] + stride;
      if (x[i] < min) x[i] = min;
    }
  }
  return x;
}

/** Shorten a body that would touch the next attack. A lone onset keeps the width it was given. */
function fitWidths(glyphs: Glyph[], melodic: boolean): void {
  const n = glyphs.length;
  if (n === 0) return;
  let shared = true;
  for (let i = 1; i < n; i++) {
    if (glyphs[i].x0 !== glyphs[0].x0) {
      shared = false;
      break;
    }
  }
  if (shared) {
    for (const glyph of glyphs) glyph.x1 = glyph.x0 + glyph.want;
    return;
  }
  for (let i = 0; i < n; i++) {
    let next = i + 1;
    while (next < n && glyphs[next].x0 === glyphs[i].x0) next++;
    let prev = i - 1;
    while (prev >= 0 && glyphs[prev].x0 === glyphs[i].x0) prev--;
    let limit: number;
    if (next < n) limit = glyphs[next].x0 - 1;
    else if (glyphs[0].x0 === 0) limit = WIDTH;
    else limit = WIDTH + glyphs[0].x0 - 1;
    // A drum hit is a slot, not a sustain. Keep it as narrow as the gap behind it
    // so the last tick of a burst does not swell into the empty bar.
    if (!melodic && prev >= 0) limit = Math.min(limit, glyphs[i].x0 + (glyphs[i].x0 - glyphs[prev].x0) - 1);
    const width = Math.max(1, Math.min(glyphs[i].want, limit - glyphs[i].x0));
    glyphs[i].x1 = glyphs[i].x0 + width;
  }
}

function pitchCenter(note: number, minNote: number, maxNote: number, yTop: number, yBottom: number, maxEvent: number): number {
  const pad = (maxEvent - 1) / 2;
  const axisTop = yTop + pad;
  const axisBottom = yBottom - pad;
  const span = maxNote - minNote;
  const high = span <= 0 ? 0.5 : (note - minNote) / span;
  return axisBottom - high * (axisBottom - axisTop);
}

function lineHeight(velocity: number, maxLine: number): number {
  const unit = Math.max(0, Math.min(1, velocity));
  return Math.max(1, Math.round(unit * maxLine));
}

/** Bass and lead span their length. A tail past the loop wraps; a note wider than one pixel keeps a 1px gap at its end. */
function noteBounds(step: number, lengthSteps: number, steps: number): [number, number] {
  const span = Math.max(lengthSteps, 1 / Math.max(1, steps));
  if (span >= steps) return [0, WIDTH];
  const x0 = (step / steps) * WIDTH;
  let x1 = x0 + (span / steps) * WIDTH;
  if (x1 < x0 + 1) x1 = x0 + 1;
  if (x1 - x0 > 1) x1 -= 1;
  const start = Math.floor(x0);
  const end = Math.floor(x1);
  if (end <= WIDTH) return [start, Math.max(start + 1, end)];
  return [start, end];
}

function paintBar(pixels: Uint8Array, x0: number, x1: number, y0: number, y1: number): void {
  const paint = (from: number, to: number) => {
    const a = Math.max(0, from);
    const b = Math.min(WIDTH, to);
    for (let x = a; x < b; x++) {
      for (let y = y0; y <= y1; y++) set(pixels, x, y, 1);
    }
  };
  if (x1 <= WIDTH) {
    paint(x0, x1);
    return;
  }
  paint(x0, WIDTH);
  const tail = x1 - WIDTH;
  if (tail > 0) paint(0, tail);
}

/** A drum hit fills its sixteenth, minus a 1px gap when the slot is wider than a pixel. */
function drumSpan(step: number, steps: number): [number, number] {
  const [x0, x1] = bucket(step, steps, WIDTH);
  const xEnd = x1 - x0 > 1 ? x1 - 1 : x1;
  return [x0, xEnd];
}

function bucket(index: number, count: number, size: number): [number, number] {
  const start = Math.floor((index * size) / count);
  const end = Math.floor(((index + 1) * size) / count);
  return [Math.min(size - 1, start), Math.min(size, Math.max(start + 1, end))];
}

/** Pitch and octave show the resting note. Rate shows its division, count shows how many hits. */
function figureHeader(project: Project, context: ContextId, binding: Binding): string | null {
  if (binding.store === "progression" && binding.path === "count" && Math.round(readControl(project, context, binding.path)) === 0) {
    return "MIDI";
  }
  switch (binding.display) {
    case "pitch":
      if (context !== "bass" && context !== "lead") return null;
      return restingPitchLabel(context, readControl(project, context, "pitch.value"), readControl(project, context, "octave.value"), project.global);
    case "octave":
      if (context !== "bass" && context !== "lead" && context !== "chords") return null;
      return `OCT ${octaveNumber(readControl(project, context, "octave.value"))}`;
    case "note":
      return pitchClassName(project.global.root);
    case "scale":
      return scaleTitle(project.global.scale);
    case "chordTone":
      if (context !== "chords") return null;
      return restingChordToneLabel(project.working.chords, project.progression, project.global);
    case "division": {
      const unit = readControl(project, context, binding.path);
      const label = context === "chords" ? chordFigure(unit).label : rateFromUnit(unit).id;
      return label.slice(0, LINE_LIMIT);
    }
    case "count":
      return String(countFromUnit(readControl(project, context, binding.path)));
    case "slice":
      if (context !== "chords") return null;
      return restingSliceLabel(project.working.chords, project.global);
    default:
      return null;
  }
}

function knobAmount(project: Project, context: ContextId, binding: Binding, ui: UiState, now: number): DisplayAmount {
  switch (binding.display) {
    case "octave": {
      if (context !== "bass" && context !== "lead" && context !== "chords") break;
      const n = octaveNumber(readControl(project, context, "octave.value"));
      return { kind: "big", n: Math.abs(n), negative: n < 0 };
    }
    case "chordTone":
      if (context !== "chords") break;
      return { kind: "wide", text: restingChordToneLabel(project.working.chords, project.progression, project.global), negative: false };
    case "note":
      return { kind: "wide", text: pitchClassName(project.global.root), negative: false };
    case "scale":
      return { kind: "wide", text: scaleShort(project.global.scale), negative: false };
    case "count":
      return { kind: "big", n: countFromUnit(readControl(project, context, binding.path)), negative: false };
    default:
      break;
  }
  if (binding.store === "deck") {
    const text = deckKnobText(project, binding.path);
    if (text) return { kind: "wide", text, negative: false };
  }
  const ret = binding.store === "macro" ? ui.macroReturns.find((item) => item.path === binding.path) : undefined;
  const coasting = ret ? macroReturnValue(ret, now) : null;
  return displayAmount(coasting ?? readControl(project, context, binding.path), binding);
}

function deckKnobText(project: Project, path: string): string | null {
  const deck = project.deck;
  switch (path) {
    case "deck.div":
      return DIV_LABEL[deck.div] ?? null;
    case "deck.len":
      return lenLabel(deck, project.global.bar);
    case "deck.brake":
      return BRAKE_LABEL[deck.brake] ?? null;
    case "deck.quant":
      return QUANT_LABEL[deck.quant] ?? null;
    default:
      return null;
  }
}

function stepAt(_project: Project, tick: number): number {
  return Math.max(0, tick) / SIXTEENTH_TICKS;
}

const LINE_LIMIT = 24;

/** Fallback center using CHAR_W; host paint re-centers with text_width. */
export function cellTextX(cell: number, text: string, textWidth = text.length * CHAR_W): number {
  const left = cell * PARAM_COL_W;
  return left + Math.max(0, Math.floor((PARAM_COL_W - textWidth) / 2));
}

function drawLabels(
  project: Project,
  context: ContextId,
  page: Page | undefined,
  focus: string | null,
  header: string,
  ui: UiState,
  now: number,
): Label[] {
  const labels: Label[] = [];
  const tag = laneTag(project, context);
  labels.push({ x: rightEdgeX(tag), y: TITLE_Y, text: tag });
  if (focus) {
    labels.push({ x: 1, y: TITLE_Y, text: header.slice(0, LINE_LIMIT) });
  } else {
    const [left, right] = page?.groups ?? [null, null];
    if (left) labels.push({ x: halfLeftX(0), y: TITLE_Y, text: left });
    if (right) labels.push({ x: halfLeftX(1), y: TITLE_Y, text: right });
  }
  page?.bindings.forEach((binding, index) => {
    if (!binding || index >= PARAM_COLS) return;
    const name = binding.short;
    const lit = focus === binding.label;
    const amount = knobAmount(project, context, binding, ui, now);
    if (amount.kind === "wide") {
      labels.push({
        x: cellTextX(index, amount.text),
        y: VALUE_Y,
        text: amount.text,
        invert: lit,
        cell: index,
        minus: amount.negative,
      });
    }
    labels.push({ x: cellTextX(index, name), y: NAME_Y, text: name, invert: lit, cell: index });
  });
  return labels;
}

function paramDigits(project: Project, context: ContextId, page: Page, focus: string | null, ui: UiState, now: number): DigitCell[] {
  const digits: DigitCell[] = [];
  page.bindings.forEach((binding, index) => {
    if (!binding || index >= PARAM_COLS) return;
    const amount = knobAmount(project, context, binding, ui, now);
    if (amount.kind !== "big") return;
    digits.push({
      cell: index,
      amount,
      invert: focus === binding.label,
    });
  });
  return digits;
}

function set(pixels: Uint8Array, x: number, y: number, value: number): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  pixels[y * WIDTH + x] = value;
}

function toggle(pixels: Uint8Array, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const index = y * WIDTH + x;
  pixels[index] = pixels[index] ? 0 : 1;
}

export function pixel(screen: Screen, x: number, y: number): number {
  return screen.pixels[y * WIDTH + x];
}
