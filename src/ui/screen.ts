import { SIXTEENTH_TICKS } from "../core/clock.ts";
import { generatePhrase, laneSteps } from "../core/phrase.ts";
import { evalModulated } from "../core/modulate.ts";
import { LANE_CODE, type ContextId, type LaneId, type Project } from "../core/types.ts";
import { readControl } from "./controls.ts";
import { pagesFor } from "./pages.ts";
import type { UiState } from "./state.ts";

export const WIDTH = 128;
export const HEIGHT = 64;
export const HEADER_H = 10;
export const VIZ_H = 32;
export const PARAM_H = 22;

export interface Label {
  x: number;
  y: number;
  text: string;
  invert?: boolean;
}

export interface Screen {
  header: string;
  viz: string;
  params: string;
  pixels: Uint8Array;
  labels: Label[];
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
  const header = focus ? fullName(focus) : laneHeader(project, context, page?.title ?? "");
  const vizLane: LaneId | null = context === "mix" || context === "global" ? null : context;
  const generator = vizLane && focusState?.generator ? focusState.generator : null;
  const viz = notice ? "notice" : generator ? "generator" : vizLane ? "phrase" : "none";
  const params = page ? page.bindings.map((binding) => binding?.label ?? "").filter(Boolean).join(" ") : "";
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  drawPager(pixels, Math.min(pageIndex, Math.max(0, pages.length - 1)), pages.length);
  for (let x = 0; x < WIDTH; x++) set(pixels, x, HEADER_H + VIZ_H - 1, 1);
  if (notice) fillViz(pixels);
  else if (generator) drawGenerator(pixels, project, context, generator, focusState?.showPattern ?? false, playing ? stepAt(project, tick) : -1);
  else if (vizLane) drawPhrase(pixels, project, vizLane, playing ? stepAt(project, tick) : -1);
  const labels = drawLabels(project, context, page, focus);
  if (notice) labels.push(...noticeLabels(notice.title, notice.value));
  return { header, viz, params, pixels, labels };
}

function fillViz(pixels: Uint8Array): void {
  for (let y = HEADER_H; y < HEADER_H + VIZ_H - 1; y++) {
    for (let x = 0; x < WIDTH; x++) set(pixels, x, y, 1);
  }
}

function noticeLabels(title: string, value: string): Label[] {
  return [
    { x: centered(title), y: HEADER_H + 6, text: title, invert: true },
    { x: centered(value), y: HEADER_H + 18, text: value, invert: true },
  ];
}

function centered(text: string): number {
  return Math.max(0, Math.floor((WIDTH - text.length * 6) / 2));
}

function laneHeader(project: Project, context: ContextId, title: string): string {
  const mute = context !== "mix" && context !== "global" && project.mute[context] ? "M" : " ";
  const lock = context !== "mix" && context !== "global" && project.lock[context] ? "L" : " ";
  return `${LANE_CODE[context]} [${mute}][${lock}] ${title}`;
}

/** Header rule, one pixel tall. The current page is solid; the others are dotted, with a 1 px gap between pages. */
function drawPager(pixels: Uint8Array, index: number, count: number): void {
  const y = HEADER_H - 1;
  if (count <= 1) {
    for (let x = 0; x < WIDTH; x++) set(pixels, x, y, 1);
    return;
  }
  const gaps = count - 1;
  const area = WIDTH - gaps;
  const edge = (i: number) => Math.floor((i * area) / count);
  let x = 0;
  for (let i = 0; i < count; i++) {
    const width = edge(i + 1) - edge(i);
    for (let p = 0; p < width; p++) {
      if (i === index || p % 2 === 0) set(pixels, x + p, y, 1);
    }
    x += width + 1;
  }
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
  const events = phrase.lanes[lane];
  const steps = Math.max(1, phrase.steps[lane]);
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
const FIELD_NAME: Record<string, string> = {
  LV: "LEVEL",
  CY: "CYCLE",
  OF: "OFFSET",
  V: "VALUE",
  P: "PATTERN",
  C: "CYCLE",
  A: "AMOUNT",
};

function fullName(label: string): string {
  const parts = label.split(" ");
  const tag = parts[parts.length - 1] ?? "";
  const word = FIELD_NAME[tag];
  if (!word) return label;
  return `${parts.slice(0, -1).join(" ")} ${word}`.trim();
}

function drawLabels(
  project: Project,
  context: ContextId,
  page: { title: string; bindings: ({ label: string; path: string; integer: boolean } | null)[] } | undefined,
  focus: string | null,
): Label[] {
  const code = LANE_CODE[context];
  const title = focus ? fullName(focus) : `${code} ${page?.title ?? ""}`.replace(/\s+/g, " ").trim();
  const labels: Label[] = [{ x: 1, y: 1, text: title.slice(0, LINE_LIMIT) }];
  const lines = pairedLines(project, context, page?.bindings ?? [], focus);
  if (lines) {
    lines.forEach((line, index) => pushLine(labels, line, 43 + index * 11));
    return labels;
  }
  page?.bindings.forEach((binding, index) => {
    if (!binding) return;
    const shown = formatValue(readControl(project, context, binding.path), binding.integer);
    const col = index % 4;
    const row = index < 4 ? 0 : 1;
    labels.push({
      x: col * 32 + 1,
      y: row === 0 ? 43 : 54,
      text: cellText(binding.label, shown),
      invert: focus === binding.label,
    });
  });
  return labels;
}

function pushLine(labels: Label[], parts: { text: string; invert: boolean }[], y: number): void {
  let x = 1;
  for (const part of parts) {
    if (!part.text) continue;
    labels.push({ x, y, text: part.text, invert: part.invert });
    x += part.text.length * 6;
  }
}

function pairedLines(
  project: Project,
  context: ContextId,
  bindings: ({ label: string; path: string; integer: boolean } | null)[],
  focus: string | null,
): { text: string; invert: boolean }[][] | null {
  const grouped = new Map<string, { tag: string; shown: string }[]>();
  const order: string[] = [];
  for (const binding of bindings) {
    if (!binding) continue;
    const parts = binding.label.split(" ");
    const tag = parts.slice(1).join(" ");
    if (!tag) return null;
    const name = parts[0];
    if (!grouped.has(name)) {
      grouped.set(name, []);
      order.push(name);
    }
    grouped.get(name)?.push({ tag, shown: formatValue(readControl(project, context, binding.path), binding.integer) });
  }
  if (order.length !== 2) return null;
  return order.map((name) => {
    const fields = grouped.get(name) ?? [];
    if (!fields.some((field) => focus === `${name} ${field.tag}`)) {
      return [{ text: fitLine(name, fields.map((field) => `${field.tag} ${field.shown}`)), invert: false }];
    }
    const parts = [{ text: name, invert: false }];
    for (const field of fields) {
      parts.push({ text: ` ${field.tag} ${field.shown}`, invert: focus === `${name} ${field.tag}` });
    }
    return parts;
  });
}

function fitLine(name: string, fields: string[]): string {
  const spaced = `${name} ${fields.join(" ")}`;
  if (spaced.length <= LINE_LIMIT) return spaced;
  const tight = `${name} ${fields.map((field) => field.replace(" ", "")).join(" ")}`;
  if (tight.length <= LINE_LIMIT) return tight;
  const body = fields.map((field) => field.replace(" ", "")).join(" ");
  const room = LINE_LIMIT - body.length - 1;
  const short = room > 0 ? name.slice(0, room) : name.slice(0, 1);
  return `${short} ${body}`.slice(0, LINE_LIMIT);
}

function cellText(label: string, shown: string): string {
  const full = `${label} ${shown}`;
  if (full.length <= 5) return full;
  const room = 5 - shown.length - 1;
  if (room < 1) return shown.slice(0, 5);
  return `${label.slice(0, room)} ${shown}`;
}

function formatValue(value: number, integer: boolean): string {
  return integer ? String(Math.round(value)) : String(Math.round(value * 100));
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
