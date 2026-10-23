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
  return { hop, period, left: new Map(), right: new Map(), past: null, readHead: null, pastSpan: 0 };
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
  let head: number | null = null;
  let span = 0;
  let next: WavePeak[] | null = null;
  let got = false;
  for (const text of texts) {
    const page = parseWavePage(text);
    if (!page) continue;
    got = true;
    head = page.head;
    span = page.span;
    if (!next) {
      next = tape.past && tape.past.length === WAVE_PAST_COLS ? tape.past.map((col) => ({ ...col })) : Array.from({ length: WAVE_PAST_COLS }, () => ({ left: 0, right: 0 }));
    }
    for (let i = 0; i < page.cols.length && i < WAVE_PAGE_COLS; i++) next[page.page * WAVE_PAGE_COLS + i] = page.cols[i];
  }
  if (!got || !next || head === null) return;
  tape.past = next;
  tape.readHead = head;
  tape.pastSpan = span;
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

/**
 * Stereo strip from the center. Left grows up, right grows down.
 * Square-root against the window peak keeps a quiet bar legible and leaves
 * the body of a note standing next to a hit.
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
  const cols: WavePeak[] = [];
  let peak = 0;
  for (let i = 0; i < view.w; i++) {
    const sample = view.head + (view.x + i - origin) * column;
    const got = wavePeak(tape, sample - column * 0.5, sample + column * 0.5, view.head);
    cols.push(got);
    if (got.left > peak) peak = got.left;
    if (got.right > peak) peak = got.right;
  }
  const scale = Math.sqrt(Math.max(peak, 1e-4));
  for (let i = 0; i < view.w; i++) {
    const x = view.x + i;
    const up = Math.round((Math.sqrt(cols[i].left) / scale) * gain * upRoom);
    const down = Math.round((Math.sqrt(cols[i].right) / scale) * gain * downRoom);
    for (let y = 1; y <= up; y++) plot(pixels, stride, x, mid - y, 1);
    for (let y = 1; y <= down; y++) plot(pixels, stride, x, mid + y, 1);
    plot(pixels, stride, x, mid, 1);
  }
  if (view.stylus) {
    const x = Math.round(origin);
    for (let y = view.y; y <= y1; y++) flip(pixels, stride, x, y);
  }
}
