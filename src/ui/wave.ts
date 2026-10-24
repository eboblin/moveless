import { WAVE_PAGE_COLS, WAVE_PAST_COLS, parseWavePage, type WavePeak } from "../dsp/deck.ts";

/** One peak per block of the master the platter stores. Shared by every view that draws audio. */
export const WAVE_HOP = 128;

export interface WaveTape {
  hop: number;
  /**
   * Loop length in samples. Positions at and after the needle fold into it.
   * 0 keeps those keys on an absolute timeline. The past is the ring, not this loop.
   */
  period: number;
  /** Phrase collage. Peak for the block that starts on this sample, left channel up. */
  left: Map<number, number>;
  /** Right channel, drawn down from the center. */
  right: Map<number, number>;
  /** 64 stereo peaks of the ring, covering the half-bar behind the read head. */
  past: WavePeak[] | null;
  /** Read position that packed `past`. The stylus uses it so the seam matches the ring. */
  readHead: number | null;
  /** Bar length, in samples, that `past` was packed with. */
  pastSpan: number;
  /** `wave0` text already merged into `past`. */
  pastText0: string;
  /** `wave1` text already merged into `past`. */
  pastText1: string;
}

export interface WaveView {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Sample under the center of the strip. */
  head: number;
  /** Samples from the left edge to the right edge. */
  span: number;
  /** 0 flattens the strip. Depth is not this. */
  gain?: number;
  /** Invert the center column. */
  stylus?: boolean;
}

export function emptyWave(hop = WAVE_HOP, period = 0): WaveTape {
  return { hop, period, left: new Map(), right: new Map(), past: null, readHead: null, pastSpan: 0, pastText0: "", pastText1: "" };
}

function fold(sample: number, period: number): number {
  const wrapped = sample % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

function keyFor(tape: WaveTape, sample: number): number {
  const at = tape.period > 0 ? fold(sample, tape.period) : sample;
  return Math.floor(at / tape.hop) * tape.hop;
}

function stored(tape: WaveTape, sample: number): WavePeak | null {
  const key = keyFor(tape, sample);
  if (!tape.left.has(key)) return null;
  return { left: tape.left.get(key) ?? 0, right: tape.right.get(key) ?? 0 };
}

/** Ring peaks for a sample behind the needle. Missing pages are silence, not the collage. */
function pastAt(tape: WaveTape, sample: number, head: number): WavePeak | null {
  const past = tape.past;
  const span = tape.pastSpan;
  if (!past || !(span > 0) || past.length === 0) return null;
  const width = span / 2;
  const start = head - width;
  if (sample < start || sample >= head) return null;
  const i = Math.min(past.length - 1, Math.max(0, Math.floor(((sample - start) / width) * past.length)));
  return past[i] ?? { left: 0, right: 0 };
}

/**
 * Peak at one sample. Behind the needle, the ring. At the needle and ahead of it,
 * the phrase collage. A beat that has not happened yet is not copied forward.
 */
export function waveAt(tape: WaveTape, sample: number, head = Number.POSITIVE_INFINITY): WavePeak | null {
  if (sample < head) return pastAt(tape, sample, head);
  return stored(tape, sample);
}

/** Loudest peak inside [from, to). Missing audio is silence. */
export function wavePeak(tape: WaveTape, from: number, to: number, head = Number.POSITIVE_INFINITY): WavePeak {
  if (!(to > from)) return { left: 0, right: 0 };
  const hop = tape.hop;
  let left = 0;
  let right = 0;
  const steps = Math.ceil((to - from) / hop) + 1;
  let sample = Math.floor(from / hop) * hop;
  for (let n = 0; n < steps && sample < to; n++) {
    const got = waveAt(tape, sample, head);
    if (got) {
      if (got.left > left) left = got.left;
      if (got.right > right) right = got.right;
    }
    sample += hop;
  }
  return { left, right };
}

/** Merge `wave0` and `wave1`. A missing page keeps the columns already stored. */
export function applyWavePages(tape: WaveTape, texts: readonly (string | null | undefined)[]): void {
  const text0 = texts[0] ?? "";
  const text1 = texts[1] ?? "";
  if (tape.pastText0 === text0 && tape.pastText1 === text1 && tape.past && tape.past.length === WAVE_PAST_COLS) return;
  let head: number | null = null;
  let span = 0;
  let next = tape.past && tape.past.length === WAVE_PAST_COLS ? tape.past : null;
  let got = false;
  for (const text of texts) {
    const page = parseWavePage(text);
    if (!page) continue;
    got = true;
    head = page.head;
    span = page.span;
    if (!next) next = Array.from({ length: WAVE_PAST_COLS }, () => ({ left: 0, right: 0 }));
    const base = page.page * WAVE_PAGE_COLS;
    for (let i = 0; i < page.cols.length && i < WAVE_PAGE_COLS; i++) {
      const dest = next[base + i];
      const col = page.cols[i];
      if (!dest || !col) continue;
      dest.left = col.left;
      dest.right = col.right;
    }
  }
  if (!got || !next || head === null) return;
  tape.past = next;
  tape.readHead = head;
  tape.pastSpan = span;
  tape.pastText0 = text0;
  tape.pastText1 = text1;
}

function plot(pixels: Uint8Array, stride: number, x: number, y: number, value: number): void {
  if (x < 0 || y < 0 || x >= stride) return;
  const index = y * stride + x;
  if (index < 0 || index >= pixels.length) return;
  pixels[index] = value;
}

function flip(pixels: Uint8Array, stride: number, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= stride) return;
  const index = y * stride + x;
  if (index < 0 || index >= pixels.length) return;
  pixels[index] = pixels[index] ? 0 : 1;
}

/** Square root against full scale, so a body stays visible and a hit keeps its height as it scrolls. */
function waveLevel(peak: number): number {
  if (!(peak > 0)) return 0;
  return Math.min(1, Math.sqrt(peak));
}

/**
 * Stereo strip from the center. Left grows up, right grows down.
 * Height is the square root of the peak on a fixed full scale.
 */
export function drawWaveform(pixels: Uint8Array, stride: number, tape: WaveTape, view: WaveView): void {
  if (view.w <= 0 || view.h <= 0 || !(view.span > 0)) return;
  const gain = view.gain ?? 1;
  const y1 = view.y + view.h - 1;
  const mid = view.y + Math.floor((view.h - 1) / 2);
  const upRoom = Math.max(1, mid - view.y);
  const downRoom = Math.max(1, y1 - mid);
  const column = view.span / view.w;
  const origin = view.x + (view.w - 1) / 2;
  for (let i = 0; i < view.w; i++) {
    const sample = view.head + (view.x + i - origin) * column;
    const got = wavePeak(tape, sample - column * 0.5, sample + column * 0.5, view.head);
    const x = view.x + i;
    const up = Math.round(waveLevel(got.left) * gain * upRoom);
    const down = Math.round(waveLevel(got.right) * gain * downRoom);
    for (let y = 1; y <= up; y++) plot(pixels, stride, x, mid - y, 1);
    for (let y = 1; y <= down; y++) plot(pixels, stride, x, mid + y, 1);
    plot(pixels, stride, x, mid, 1);
  }
  if (view.stylus) {
    const x = Math.round(origin);
    for (let y = view.y; y <= y1; y++) flip(pixels, stride, x, y);
  }
}

/**
 * Same strip as {@link drawWaveform}, sent as column rectangles.
 * The stylus column is inverted one pixel at a time.
 */
export function strokeWaveform(
  tape: WaveTape,
  view: WaveView,
  rect: (x: number, y: number, w: number, h: number, value: number) => void,
  pixel: (x: number, y: number, value: number) => void,
): void {
  if (view.w <= 0 || view.h <= 0 || !(view.span > 0)) return;
  const gain = view.gain ?? 1;
  const y1 = view.y + view.h - 1;
  const mid = view.y + Math.floor((view.h - 1) / 2);
  const upRoom = Math.max(1, mid - view.y);
  const downRoom = Math.max(1, y1 - mid);
  const column = view.span / view.w;
  const origin = view.x + (view.w - 1) / 2;
  const stylusX = view.stylus ? Math.round(origin) : -1;
  rect(view.x, mid, view.w, 1, 1);
  let stylusUp = 0;
  let stylusDown = 0;
  for (let i = 0; i < view.w; i++) {
    const sample = view.head + (view.x + i - origin) * column;
    const got = wavePeak(tape, sample - column * 0.5, sample + column * 0.5, view.head);
    const x = view.x + i;
    const up = Math.round(waveLevel(got.left) * gain * upRoom);
    const down = Math.round(waveLevel(got.right) * gain * downRoom);
    if (x === stylusX) {
      stylusUp = up;
      stylusDown = down;
      continue;
    }
    if (up > 0) rect(x, mid - up, 1, up, 1);
    if (down > 0) rect(x, mid + 1, 1, down, 1);
  }
  if (!view.stylus) return;
  for (let y = view.y; y <= y1; y++) {
    const lit = y === mid || (y < mid && y >= mid - stylusUp) || (y > mid && y <= mid + stylusDown);
    pixel(stylusX, y, lit ? 0 : 1);
  }
}
