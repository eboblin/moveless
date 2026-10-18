import { morphBarSide } from "../core/blend.ts";
import { laneHeard } from "../core/journal.ts";
import { SIXTEENTH_TICKS } from "../core/clock.ts";
import { phraseStepsOf } from "../core/events.ts";
import { chordSymbol, degreeNumeral, pitchClassName, scaleShort, scaleTitle } from "../core/harmony.ts";
import { chordFigure, endpointLanes, endpointPhrases, generatePhrase, laneSteps, octaveNumber, restingChordToneLabel, restingPitchLabel } from "../core/phrase.ts";
import { evalModulated } from "../core/modulate.ts";
import { CAPTURE_DEPTHS, CAPTURE_INTENSITIES, CAPTURE_SCOPES, isPitched, LANES, LANE_CODE, type AuxId, type CaptureDepth, type CaptureIntensity, type CaptureScope, type ContextId, type HarmonicEvent, type LaneId, type Phrase, type Project, type TimedEvent } from "../core/types.ts";
import { DIGIT_H, displayAmount, type BigAmount, type DisplayAmount } from "./digits.ts";
import { readControl } from "./controls.ts";
import { bindingFor, pagesFor, type Binding, type Page } from "../core/pages.ts";
import { focusVisible, peekKind, type UiState } from "./state.ts";

export const WIDTH = 128;
export const HEIGHT = 64;
/** Typical advance for the bundled 4×5 face (cap body + 1 px gap). */
export const CHAR_W = 5;
export const FONT_H = 5;
export const PARAM_COLS = 8;
export const PARAM_COL_W = WIDTH / PARAM_COLS;
/** Header: title, 1 px gap, pager, 1 px gap, then viz. */
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
}

export function renderScreen(
  project: Project,
  ui: UiState,
  tick: number,
  playing = false,
  now = Date.now(),
  pixels: Uint8Array = new Uint8Array(WIDTH * HEIGHT),
): Screen {
  const peek = ui.heldContext;
  const context = peek ?? ui.context;
  const pageIndex = peek ? ui.heldPage ?? ui.lanePages[peek] ?? 0 : ui.page;
  const pages = pagesFor(context);
  const page = pages[Math.min(pageIndex, pages.length - 1)];
  const kind = peekKind(ui);
  const capture = kind === "capture";
  const notice = !capture && ui.notice && now < ui.notice.untilMs ? ui.notice : null;
  const focusState = !notice && !capture && focusVisible(ui.focus, tick, now) ? ui.focus : null;
  const focus = focusState?.label ?? null;
  const focusBinding = focusState ? bindingFor(focusState.path) : null;
  const mixer = !notice && !capture && kind === "mute";
  const header = mixer
    ? (focusBinding?.title ?? focus ?? "MIXER")
    : (focusBinding ? figureHeader(project, context, focusBinding) : null) ??
      focusBinding?.title ??
      (focus ? focus : laneHeader(project, context, page));
  const vizLane: LaneId | null = isAux(context) ? null : context;
  const generator = vizLane && focusState?.generator ? focusState.generator : null;
  const bars = !notice && !capture && !mixer && page?.id === "prog";
  const viz = capture ? "capture" : notice ? "notice" : mixer ? "mixer" : generator ? "generator" : vizLane || bars ? "phrase" : "none";
  pixels.fill(0);
  drawPager(pixels, mixer ? 0 : Math.min(pageIndex, Math.max(0, pages.length - 1)), mixer ? 1 : pages.length);
  if (!mixer) drawParamSeparator(pixels);
  const chordRoll = vizLane === "chords" && !capture;
  const showPhrase = !notice && !mixer && !generator && !capture && (vizLane !== null || bars);
  const phrase = showPhrase ? generatePhrase(project) : null;
  if (notice) fillViz(pixels);
  else if (mixer) drawMixer(pixels, project, focus);
  else if (generator) drawGenerator(pixels, project, context, generator, focusState?.showPattern ?? false, playing ? stepAt(project, tick) : -1);
  else if (bars && phrase) drawChordBars(pixels, phrase, playing ? stepAt(project, tick) : -1);
  else if (chordRoll && phrase) drawChordRoll(pixels, phrase, playing ? stepAt(project, tick) : -1);
  else if (vizLane && phrase) drawPhrase(pixels, project, phrase, vizLane, playing ? stepAt(project, tick) : -1);
  const labels = mixer
    ? [{ x: 1, y: 1, text: header.slice(0, LINE_LIMIT) }, ...mixerChannelLabels(project, focus)]
    : drawLabels(project, context, page, focus, header);
  if (phrase && bars) labels.push(...chordNameLabels(project, phrase));
  if (notice) labels.push(...noticeLabels(notice.title, notice.value));
  if (capture) labels.push(...captureMenuLabels(project));
  const digits = mixer || !page ? [] : paramDigits(project, context, page, focus);
  return { header, viz, pixels, labels, digits };
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

const DEPTH_WORD: Record<CaptureDepth, string> = { all: "ALL", generators: "GENERATORS", values: "VALUES" };
const SCOPE_WORD: Record<CaptureScope, string> = { lane: "LANE", group: "GROUP", page: "PAGE" };
const INTENSITY_WORD: Record<CaptureIntensity, string> = { clear: "DELETE", soft: "LOW", medium: "MED", hard: "HIGH" };

function captureMenuLabels(project: Project): Label[] {
  const step = FONT_H + 4;
  const y0 = HEADER_H + 4;
  return [
    ...menuLine(CAPTURE_DEPTHS.map((id) => DEPTH_WORD[id]), DEPTH_WORD[project.captureDepth], y0),
    ...menuLine(CAPTURE_SCOPES.map((id) => SCOPE_WORD[id]), SCOPE_WORD[project.captureScope], y0 + step),
    ...menuLine(CAPTURE_INTENSITIES.map((id) => INTENSITY_WORD[id]), INTENSITY_WORD[project.captureIntensity], y0 + step * 2),
  ];
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

function isAux(context: ContextId): context is AuxId {
  return context === "aux";
}

function laneTag(project: Project, context: ContextId): string {
  let tag = LANE_CODE[context];
  if (!isAux(context)) {
    if (project.mute[context]) tag += "M";
    if (project.solo[context]) tag += "S";
    if (project.lock[context]) tag += "L";
  }
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

/** Solid rule above the knob parameter strip. */
function drawParamSeparator(pixels: Uint8Array): void {
  for (let x = 0; x < WIDTH; x++) set(pixels, x, SEP_Y, 1);
}

function drawGenerator(pixels: Uint8Array, project: Project, context: ContextId, path: string, showPattern: boolean, playhead: number): void {
  const value = readControl(project, context, `${path}.value`);
  const pattern = readControl(project, context, `${path}.pattern`);
  const cycle = Math.max(1, Math.round(readControl(project, context, `${path}.cycle`)));
  const stored = readControl(project, context, `${path}.amount`);
  const amount = showPattern && stored === 0 ? 1 : stored;
  const lane: LaneId = isAux(context) ? "kick" : context;
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
    if (numeral.length > chars) continue;
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
  const events = phrase.lanes.chords;
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  let minNote = events[0]?.note ?? 0;
  let maxNote = minNote;
  for (const event of events) {
    minNote = Math.min(minNote, event.note);
    maxNote = Math.max(maxNote, event.note);
  }
  const yOf = (note: number) => {
    if (maxNote === minNote) return Math.floor((yTop + yBottom) / 2);
    const high = (note - minNote) / (maxNote - minNote);
    return yBottom - Math.round(high * (yBottom - yTop));
  };
  for (const event of events) {
    const start = wrapStep(event.tick / SIXTEENTH_TICKS, steps);
    const end = Math.min(steps, start + event.lengthTicks / SIXTEENTH_TICKS);
    const x0 = Math.min(WIDTH - 1, Math.floor((start * WIDTH) / steps));
    const x1 = Math.min(WIDTH, Math.max(x0 + 1, Math.floor((end * WIDTH) / steps)));
    const y = yOf(event.note);
    for (let x = x0; x < x1; x++) set(pixels, x, y, 1);
  }
  if (playhead >= 0) paintPlayhead(pixels, wrapStep(playhead, steps), steps, yTop, yBottom);
}

function drawPhrase(pixels: Uint8Array, project: Project, phrase: Phrase, lane: LaneId, playhead: number): void {
  const view = lanePicture(project, phrase, lane, playhead);
  const steps = Math.max(1, view.steps);
  const events = lane === "chords" ? view.events : collapseMono(view.events, steps);
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  const maxEvent = Math.floor(VIZ_H / 2);
  let minNote = events[0]?.note ?? 0;
  let maxNote = minNote;
  for (const event of events) {
    minNote = Math.min(minNote, event.note);
    maxNote = Math.max(maxNote, event.note);
  }
  const melodic = isPitched(lane);
  for (const event of events) {
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
    if (melodic) {
      paintNoteLength(pixels, wrapStep(event.tick / SIXTEENTH_TICKS, steps), event.lengthTicks / SIXTEENTH_TICKS, steps, y0, y1);
      continue;
    }
    const [x0, x1] = bucket(wrapStep(event.tick / SIXTEENTH_TICKS, steps), steps, WIDTH);
    const xEnd = x1 - x0 > 1 ? x1 - 1 : x1;
    for (let x = x0; x < xEnd; x++) {
      for (let y = y0; y <= y1; y++) set(pixels, x, y, 1);
    }
  }
  if (view.playhead >= 0) paintPlayhead(pixels, wrapStep(view.playhead, steps), steps, yTop, yBottom);
}

/**
 * The page shows the mixed phrase at the length of the side that owns the
 * downbeat. While the morph window is longer than that phrase, the picture
 * advances one phrase per cursor pass. When the downbeat crosses, the length
 * becomes the other side's phrase. A pattern longer than the voice window is
 * drawn from that side's own phrase, at its own length.
 */
function lanePicture(project: Project, phrase: Phrase, lane: LaneId, playhead: number): { steps: number; events: TimedEvent[]; playhead: number } {
  const full = Math.max(1, phrase.steps[lane]);
  const width = patternSteps(project, lane);
  if (width == null) return { steps: full, events: phrase.lanes[lane], playhead };
  if (width > full) {
    const cursor = phraseCursor(project, playhead, width);
    return { steps: width, events: sideEvents(project, lane, width), playhead: playhead < 0 ? -1 : cursor };
  }
  if (width === full) {
    const cursor = phraseCursor(project, playhead, width);
    return { steps: width, events: phrase.lanes[lane], playhead: playhead < 0 ? -1 : cursor };
  }
  const cursor = phraseCursor(project, playhead, full);
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

/** Phrase length of the side that owns the downbeat. Chords stay on the shared phrase. */
function patternSteps(project: Project, lane: LaneId): number | null {
  if (!project.morph || lane === "chords") return null;
  const trees = endpointLanes(project);
  if (!trees) return null;
  const useSource = project.lock[lane] || morphBarSide(project) === "src";
  const tree = (useSource ? trees.from : trees.to)[lane];
  if (!("gen1" in tree)) return null;
  return Math.max(1, phraseStepsOf(tree.gen1, tree.gen2));
}

/** Endpoint events for a pattern the voice window had to crop. */
function sideEvents(project: Project, lane: LaneId, steps: number): TimedEvent[] {
  const phrases = endpointPhrases(project);
  if (!phrases) return [];
  const useSource = project.lock[lane] || morphBarSide(project) === "src";
  const endTick = steps * SIXTEENTH_TICKS;
  return (useSource ? phrases.from : phrases.to).lanes[lane].filter((event) => event.tick < endTick);
}

function phraseCursor(project: Project, playhead: number, steps: number): number {
  const morph = project.morph;
  const raw = playhead >= 0
    ? playhead
    : morph
      ? Math.floor((morph.originTick + morph.t * Math.max(0, morph.durationTicks)) / SIXTEENTH_TICKS)
      : 0;
  return ((raw % steps) + steps) % steps;
}

function paintPlayhead(pixels: Uint8Array, pos: number, steps: number, yTop: number, yBottom: number): void {
  const x = Math.min(WIDTH - 1, Math.floor((pos * WIDTH) / steps));
  for (let y = yTop; y <= yBottom; y++) toggle(pixels, x, y);
}

/** Keep a time inside one lane loop. A ratchet or repeat past the end returns to the start. */
function wrapStep(step: number, steps: number): number {
  return ((step % steps) + steps) % steps;
}

/** Drums, bass and lead are monophonic: one drawn event per sixteenth. */
function collapseMono(events: TimedEvent[], steps: number): TimedEvent[] {
  const best = new Map<number, TimedEvent>();
  for (const event of events) {
    const key = Math.floor(wrapStep(event.tick / SIXTEENTH_TICKS, steps) + 1e-9);
    const prev = best.get(key);
    if (!prev || event.velocity > prev.velocity || (event.velocity === prev.velocity && event.tick >= prev.tick)) {
      best.set(key, event);
    }
  }
  return [...best.values()];
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
function paintNoteLength(pixels: Uint8Array, step: number, lengthSteps: number, steps: number, y0: number, y1: number): void {
  const span = Math.max(lengthSteps, 1 / Math.max(1, steps));
  const paint = (from: number, to: number) => {
    const a = Math.max(0, from);
    const b = Math.min(WIDTH, to);
    for (let x = a; x < b; x++) {
      for (let y = y0; y <= y1; y++) set(pixels, x, y, 1);
    }
  };
  if (span >= steps) {
    paint(0, WIDTH);
    return;
  }
  const x0 = (step / steps) * WIDTH;
  let x1 = x0 + (span / steps) * WIDTH;
  if (x1 < x0 + 1) x1 = x0 + 1;
  if (x1 - x0 > 1) x1 -= 1;
  const start = Math.floor(x0);
  const end = Math.floor(x1);
  if (end <= WIDTH) {
    paint(start, Math.max(start + 1, end));
    return;
  }
  paint(start, WIDTH);
  const tail = end - WIDTH;
  if (tail > 0) paint(0, tail);
}

function bucket(index: number, count: number, size: number): [number, number] {
  const start = Math.floor((index * size) / count);
  const end = Math.floor(((index + 1) * size) / count);
  return [Math.min(size - 1, start), Math.min(size, Math.max(start + 1, end))];
}

/** Pitch and octave show the resting note. Chord rate shows BLOCK or a division. */
function figureHeader(project: Project, context: ContextId, binding: Binding): string | null {
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
    case "division":
      if (context !== "chords") return null;
      return chordFigure(readControl(project, "chords", "rate.value")).label.slice(0, LINE_LIMIT);
    default:
      return null;
  }
}

function knobAmount(project: Project, context: ContextId, binding: Binding): DisplayAmount {
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
    default:
      break;
  }
  return displayAmount(readControl(project, context, binding.path), binding);
}

function stepAt(_project: Project, tick: number): number {
  return Math.floor(Math.max(0, tick) / 48);
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
    const amount = knobAmount(project, context, binding);
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

function paramDigits(project: Project, context: ContextId, page: Page, focus: string | null): DigitCell[] {
  const digits: DigitCell[] = [];
  page.bindings.forEach((binding, index) => {
    if (!binding || index >= PARAM_COLS) return;
    const amount = knobAmount(project, context, binding);
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
