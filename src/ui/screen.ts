import { SIXTEENTH_TICKS } from "../core/clock.ts";
import { generatePhrase, laneSteps } from "../core/phrase.ts";
import { evalModulated } from "../core/modulate.ts";
import { LANE_CODE, type ContextId, type LaneId, type Project, type TimedEvent } from "../core/types.ts";
import { DIGIT_H, displayAmount, type BigAmount } from "./digits.ts";
import { readControl } from "./controls.ts";
import { pagesFor, type Page } from "./pages.ts";
import type { UiState } from "./state.ts";

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
  params: string;
  pixels: Uint8Array;
  labels: Label[];
  digits: DigitCell[];
}

export function renderScreen(project: Project, ui: UiState, tick: number, playing = false, now = Date.now()): Screen {
  const peek = ui.heldLane;
  const context = peek ?? ui.context;
  const pageIndex = peek ? ui.heldPage ?? ui.page : ui.page;
  const pages = pagesFor(context === "mix" || context === "global" ? context : context);
  const page = pages[Math.min(pageIndex, pages.length - 1)];
  const notice = ui.notice && now < ui.notice.untilMs ? ui.notice : null;
  const focusState = !notice && ui.focus && (ui.focus.held || tick < ui.focus.untilTick) ? ui.focus : null;
  const focus = focusState?.label ?? null;
  const header = focus ? fullName(focus) : laneHeader(project, context, page);
  const vizLane: LaneId | null = context === "mix" || context === "global" ? null : context;
  const generator = vizLane && focusState?.generator ? focusState.generator : null;
  const mixer = !notice && context === "mix";
  const viz = notice ? "notice" : mixer ? "mixer" : generator ? "generator" : vizLane ? "phrase" : "none";
  const params = page ? page.bindings.map((binding) => binding?.label ?? "").filter(Boolean).join(" ") : "";
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  drawPager(pixels, Math.min(pageIndex, Math.max(0, pages.length - 1)), pages.length);
  if (!mixer) drawParamSeparator(pixels);
  if (notice) fillViz(pixels);
  else if (mixer) drawMixer(pixels, project, focus);
  else if (generator) drawGenerator(pixels, project, context, generator, focusState?.showPattern ?? false, playing ? stepAt(project, tick) : -1);
  else if (vizLane) drawPhrase(pixels, project, vizLane, playing ? stepAt(project, tick) : -1);
  const labels = mixer
    ? [{ x: 1, y: 1, text: header.slice(0, LINE_LIMIT) }, ...mixerChannelLabels(project, focus)]
    : drawLabels(project, context, page, focus);
  if (notice) labels.push(...noticeLabels(notice.title, notice.value));
  const digits = mixer || !page ? [] : paramDigits(project, context, page, focus);
  return { header, viz, params, pixels, labels, digits };
}

function fillViz(pixels: Uint8Array): void {
  for (let y = HEADER_H; y < HEADER_H + VIZ_H - 1; y++) {
    for (let x = 0; x < WIDTH; x++) set(pixels, x, y, 1);
  }
}

const MIX_CHANNELS = ["kick", "snare", "hat", "perc", "bass", "lead", "chords", "master"] as const;
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
  }
}

function mixerChannelLabels(project: Project, focus: string | null): Label[] {
  const labels: Label[] = [];
  for (let i = 0; i < MIX_CHANNELS.length; i++) {
    const id = MIX_CHANNELS[i];
    const x0 = i * MIX_COL_W;
    if (id !== "master") {
      const marks = `${project.mute[id] ? "M" : ""}${project.lock[id] ? "L" : ""}`;
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
  if (context !== "mix" && context !== "global") {
    if (project.mute[context]) tag += "M";
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
  const lane: LaneId = context === "mix" || context === "global" ? "kick" : context;
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

function drawPhrase(pixels: Uint8Array, project: Project, lane: LaneId, playhead: number): void {
  const phrase = generatePhrase(project);
  const steps = Math.max(1, phrase.steps[lane]);
  const events = lane === "chords" ? phrase.lanes[lane] : collapseMono(phrase.lanes[lane], steps);
  const yTop = HEADER_H;
  const yBottom = HEADER_H + VIZ_H - 2;
  const maxEvent = Math.floor(VIZ_H / 2);
  let minNote = events[0]?.note ?? 0;
  let maxNote = minNote;
  for (const event of events) {
    minNote = Math.min(minNote, event.note);
    maxNote = Math.max(maxNote, event.note);
  }
  for (const event of events) {
    const [x0, x1] = bucket(wrapStep(event.tick / SIXTEENTH_TICKS, steps), steps, WIDTH);
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
    const xEnd = x1 - x0 > 1 ? x1 - 1 : x1;
    for (let x = x0; x < xEnd; x++) {
      for (let y = y0; y <= y1; y++) set(pixels, x, y, 1);
    }
  }
  if (playhead >= 0) paintPlayhead(pixels, wrapStep(playhead, steps), steps, yTop, yBottom);
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

function bucket(index: number, count: number, size: number): [number, number] {
  const start = Math.floor((index * size) / count);
  const end = Math.floor(((index + 1) * size) / count);
  return [Math.min(size - 1, start), Math.min(size, Math.max(start + 1, end))];
}

function stepAt(_project: Project, tick: number): number {
  return Math.floor(Math.max(0, tick) / 48);
}

const LINE_LIMIT = 24;
/** Expands each token of a binding label for the focus header. */
const WORD: Record<string, string> = {
  G1: "GEN 1",
  G2: "GEN 2",
  LEN: "LENGTH",
  HIT: "HITS",
  ROT: "ROTATE",
  PRB: "PROB",
  VEL: "VELOCITY",
  V: "VALUE",
  P: "PATTERN",
  C: "CYCLE",
  A: "AMOUNT",
  TRANS: "TRANSPOSE",
  OCT: "OCTAVES",
  DIR: "DIRECTION",
  KCK: "KICK",
  SNR: "SNARE",
  PRC: "PERC",
  BAS: "BASS",
  LEA: "LEAD",
  CHD: "CHORDS",
  LV: "LEVEL",
  CY: "CYCLE",
  OF: "OFFSET",
};

function fullName(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .map((part) => WORD[part] ?? part)
    .join(" ");
}

/** Last token, max 3 letters — fits a PARAM_COL_W cell at CHAR_W. */
function shortName(label: string): string {
  const parts = label.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? "").slice(0, 3);
}

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
): Label[] {
  const labels: Label[] = [];
  const tag = laneTag(project, context);
  labels.push({ x: rightEdgeX(tag), y: TITLE_Y, text: tag });
  if (focus) {
    labels.push({ x: 1, y: TITLE_Y, text: fullName(focus).slice(0, LINE_LIMIT) });
  } else {
    const [left, right] = page?.groups ?? [null, null];
    if (left) labels.push({ x: halfLeftX(0), y: TITLE_Y, text: left });
    if (right) labels.push({ x: halfLeftX(1), y: TITLE_Y, text: right });
  }
  page?.bindings.forEach((binding, index) => {
    if (!binding || index >= PARAM_COLS) return;
    const name = shortName(binding.label);
    const lit = focus === binding.label;
    const amount = displayAmount(readControl(project, context, binding.path), binding);
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
    const amount = displayAmount(readControl(project, context, binding.path), binding);
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
