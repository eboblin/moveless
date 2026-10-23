/** One peak per block of the master the platter stores. Shared by every view that draws audio. */
export const WAVE_HOP = 128;

export interface WaveTape {
  hop: number;
  /**
   * Loop length in samples. Positions fold into it, so a needle sees the phrase
   * both behind and ahead. 0 keeps the keys on an absolute timeline.
   */
  period: number;
  /** Peak amplitude for the block that starts on this sample, left channel up. */
  left: Map<number, number>;
  /** Right channel, drawn down from the center. */
  right: Map<number, number>;
  /** Previous loop. Positions behind the needle use it while this pass is still rendering. */
  held?: WaveTape;
  /** Phrase envelope for the same loop. Fills the past on the first frame, before any block is rendered. */
  sketch?: WaveTape;
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
  /** Beat length in samples. Future hops that are not rendered yet copy the past on this grid. */
  beat?: number;
}

export function emptyWave(hop = WAVE_HOP, period = 0): WaveTape {
  return { hop, period, left: new Map(), right: new Map() };
}

function fold(sample: number, period: number): number {
  const wrapped = sample % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

function keyFor(tape: WaveTape, sample: number): number {
  const at = tape.period > 0 ? fold(sample, tape.period) : sample;
  return Math.floor(at / tape.hop) * tape.hop;
}

function stored(tape: WaveTape, sample: number): { left: number; right: number } | null {
  const key = keyFor(tape, sample);
  if (!tape.left.has(key)) return null;
  return { left: tape.left.get(key) ?? 0, right: tape.right.get(key) ?? 0 };
}

/** Audio already known at this phase: the previous render, then the phrase envelope. */
function remembered(tape: WaveTape, sample: number): { left: number; right: number } | null {
  if (tape.held) {
    const held = stored(tape.held, sample);
    if (held) return held;
  }
  if (tape.sketch) {
    const drawn = stored(tape.sketch, sample);
    if (drawn) return drawn;
  }
  if (tape.held?.sketch) {
    const older = stored(tape.held.sketch, sample);
    if (older) return older;
  }
  return null;
}

/**
 * Peak at one sample. A rendered hop wins. Behind the needle, the held loop or
 * the phrase envelope stands in at once. Ahead of the needle, a missing hop
 * copies the same place in an earlier beat.
 */
export function waveAt(
  tape: WaveTape,
  sample: number,
  head = Number.POSITIVE_INFINITY,
  beat = 0,
): { left: number; right: number } | null {
  const real = stored(tape, sample);
  if (real) return real;
  if (sample < head) {
    const past = remembered(tape, sample);
    if (past) return past;
  }
  if (!(beat > 0) || sample < head) return null;
  let source = sample;
  for (let n = 0; n < 16; n++) {
    source -= beat;
    if (source >= head) continue;
    const got = stored(tape, source) ?? remembered(tape, source);
    if (got) return got;
  }
  return null;
}

/** Loudest peak inside [from, to). Missing audio is silence. `beat` fills the future from the past. */
export function wavePeak(
  tape: WaveTape,
  from: number,
  to: number,
  head = Number.POSITIVE_INFINITY,
  beat = 0,
): { left: number; right: number } {
  if (!(to > from)) return { left: 0, right: 0 };
  const hop = tape.hop;
  let left = 0;
  let right = 0;
  const steps = Math.ceil((to - from) / hop) + 1;
  let sample = Math.floor(from / hop) * hop;
  for (let n = 0; n < steps && sample < to; n++) {
    const got = waveAt(tape, sample, head, beat);
    if (got) {
      if (got.left > left) left = got.left;
      if (got.right > right) right = got.right;
    }
    sample += hop;
  }
  return { left, right };
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
  const cols: { left: number; right: number }[] = [];
  let peak = 0;
  for (let i = 0; i < view.w; i++) {
    const sample = view.head + (view.x + i - origin) * column;
    const got = wavePeak(tape, sample - column * 0.5, sample + column * 0.5, view.head, view.beat ?? 0);
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
