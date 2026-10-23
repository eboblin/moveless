import {
  DECK_FADE,
  barSamples,
  deckRead,
  defaultDeck,
  type DeckGesture,
  type DeckKnobs,
  type DeckMoment,
  type DeckRead,
} from "../core/deck.ts";

/** A few seconds of the master, enough for a bar at ordinary tempos. */
const RING_BITS = 18;
const RING = 1 << RING_BITS;

export interface DeckRuntime {
  knobs: DeckKnobs;
  /** Gesture the reader is still sounding, including the release fade. */
  gesture: DeckGesture | null;
  /** Gesture last requested. Distinct from `gesture` so the fade is not restarted. */
  command: DeckGesture | null;
  /** Pad press that started `command`. A new press of the same cell still retriggers. */
  press: number;
  down: number;
  up: number | null;
  warm: boolean;
  seed: number;
  barBeats: number;
  ringL: Float32Array;
  ringR: Float32Array;
  mask: number;
  /** One past the newest sample written. */
  filled: number;
  /** Max |sample| per 128-sample hop, same slots the device ring keeps. */
  peakL: Float32Array;
  peakR: Float32Array;
  /** How many samples past the live clock the ring already holds. */
  lead: number;
  /** Shadow render skips the platter so it can fill the ring. */
  bypass: boolean;
}

export function createDeckRuntime(): DeckRuntime {
  return {
    knobs: defaultDeck(),
    gesture: null,
    command: null,
    press: 0,
    down: 0,
    up: null,
    warm: false,
    seed: 1,
    barBeats: 4,
    ringL: new Float32Array(RING),
    ringR: new Float32Array(RING),
    mask: RING - 1,
    filled: 0,
    peakL: new Float32Array(RING >> 7),
    peakR: new Float32Array(RING >> 7),
    lead: 0,
    bypass: false,
  };
}

export function deckTargetLead(tempo: number, barBeats: number): number {
  return Math.min(RING >> 1, barSamples(tempo, barBeats));
}

/** Remember a command. A new gesture grabs the clock; letting go only arms the fade. */
export function commandDeck(deck: DeckRuntime, gesture: DeckGesture | null, clock: number, press = 0): void {
  if (gesture === deck.command && press === deck.press) return;
  deck.command = gesture;
  deck.press = press;
  if (gesture) {
    deck.gesture = gesture;
    deck.down = clock;
    deck.up = null;
    return;
  }
  if (deck.gesture && deck.up === null) deck.up = clock;
}

export function noteDeck(deck: DeckRuntime, sample: number, left: number, right: number): void {
  const i = sample & deck.mask;
  deck.ringL[i] = left;
  deck.ringR[i] = right;
  if (sample + 1 > deck.filled) deck.filled = sample + 1;
  if (sample < 0) return;
  const hop = (sample >> 7) & ((RING >> 7) - 1);
  if ((sample & 127) === 0) {
    deck.peakL[hop] = 0;
    deck.peakR[hop] = 0;
  }
  const al = Math.abs(left);
  const ar = Math.abs(right);
  if (al > deck.peakL[hop]) deck.peakL[hop] = al;
  if (ar > deck.peakR[hop]) deck.peakR[hop] = ar;
}

function readAt(deck: DeckRuntime, pos: number): [number, number] {
  const i0 = Math.floor(pos);
  if (i0 < 0 || i0 >= deck.filled) return [0, 0];
  const frac = pos - i0;
  const a = i0 & deck.mask;
  const b = (i0 + 1) & deck.mask;
  const bOk = i0 + 1 < deck.filled;
  const l0 = deck.ringL[a];
  const r0 = deck.ringR[a];
  const l1 = bOk ? deck.ringL[b] : l0;
  const r1 = bOk ? deck.ringR[b] : r0;
  return [l0 * (1 - frac) + l1 * frac, r0 * (1 - frac) + r1 * frac];
}

function momentAt(deck: DeckRuntime, now: number, tempo: number): DeckMoment {
  return {
    gesture: deck.gesture,
    down: deck.down,
    up: deck.up,
    now,
    tempo,
    barBeats: deck.barBeats,
    knobs: deck.knobs,
    ahead: deck.lead,
    seed: deck.seed,
  };
}

export function deckThrow(deck: DeckRuntime, now: number, tempo: number): number {
  if (deck.bypass || !deck.gesture) return 0;
  return deckRead(momentAt(deck, now, tempo)).throw * Math.max(0, Math.min(1, deck.knobs.depth));
}

/** Hear the platter. `left`/`right` are the master just rendered, before the soft clip. */
export function hearDeck(deck: DeckRuntime, now: number, tempo: number, left: number, right: number): [number, number] {
  if (!deck.bypass) noteDeck(deck, now, left, right);
  if (deck.bypass || !deck.gesture) return [left, right];
  const read: DeckRead = deckRead(momentAt(deck, now, tempo));
  const [srcL, srcR] = read.live >= 1 ? [left, right] : readAt(deck, read.pos);
  const wetL = (left * read.live + srcL * (1 - read.live)) * read.gain;
  const wetR = (right * read.live + srcR * (1 - read.live)) * read.gain;
  const depth = Math.max(0, Math.min(1, deck.knobs.depth));
  if (deck.up !== null && now >= deck.up + DECK_FADE) deck.gesture = null;
  return [left * (1 - depth) + wetL * depth, right * (1 - depth) + wetR * depth];
}

export function writeDeckBlock(deck: DeckRuntime, start: number, interleaved: Float32Array): void {
  const frames = interleaved.length / 2;
  for (let i = 0; i < frames; i++) noteDeck(deck, start + i, interleaved[i * 2], interleaved[i * 2 + 1]);
}

/** Columns on the left of the stylus. Matches the `wave0` / `wave1` pages in dsp.so. */
export const WAVE_PAST_COLS = 64;
export const WAVE_PAGE_COLS = 32;

export interface WavePeak {
  left: number;
  right: number;
}

export interface WavePage {
  page: number;
  head: number;
  span: number;
  cols: WavePeak[];
}

function hopMax(deck: DeckRuntime, from: number, to: number): WavePeak {
  const filled = deck.filled;
  const oldest = Math.max(0, filled - (deck.mask + 1));
  let s = Math.max(oldest, Math.floor(from));
  const end = Math.min(filled, Math.ceil(to));
  let left = 0;
  let right = 0;
  while (s < end) {
    const hop = (s >> 7) & ((RING >> 7) - 1);
    if (deck.peakL[hop] > left) left = deck.peakL[hop];
    if (deck.peakR[hop] > right) right = deck.peakR[hop];
    const next = (s & ~127) + 128;
    s = next > s ? next : s + 1;
  }
  return { left, right };
}

/** 64 stereo peaks covering [head - span/2, head). Unwritten samples stay silent. */
export function pastColumns(deck: DeckRuntime, head: number, span: number, count = WAVE_PAST_COLS): WavePeak[] {
  const width = span / 2;
  const start = head - width;
  const col = count > 0 ? width / count : width;
  const cols: WavePeak[] = [];
  for (let i = 0; i < count; i++) {
    const from = start + i * col;
    cols.push(hopMax(deck, from, from + col));
  }
  return cols;
}

function nibble(peak: number): string {
  const clamped = Math.max(0, Math.min(1, peak));
  const n = Math.max(0, Math.min(15, Math.round(clamped * 15)));
  return n.toString(16);
}

/** `page|head|span|` plus 32 left/right nibbles. A short host buffer gets the other page. */
export function formatWavePage(page: number, head: number, span: number, cols: WavePeak[]): string {
  const start = page * WAVE_PAGE_COLS;
  let hex = "";
  for (let i = 0; i < WAVE_PAGE_COLS; i++) {
    const col = cols[start + i] ?? { left: 0, right: 0 };
    hex += nibble(col.left) + nibble(col.right);
  }
  return `${page}|${Math.round(head)}|${Math.round(span)}|${hex}`;
}

export function parseWavePage(text: string | null | undefined): WavePage | null {
  if (!text) return null;
  const parts = text.split("|");
  if (parts.length !== 4) return null;
  const page = Number(parts[0]);
  const head = Number(parts[1]);
  const span = Number(parts[2]);
  const hex = parts[3] ?? "";
  if (page !== 0 && page !== 1) return null;
  if (!Number.isInteger(head) || !Number.isInteger(span) || !(span > 0)) return null;
  if (hex.length !== WAVE_PAGE_COLS * 2) return null;
  const cols: WavePeak[] = [];
  for (let i = 0; i < WAVE_PAGE_COLS; i++) {
    const left = Number.parseInt(hex[i * 2] ?? "", 16);
    const right = Number.parseInt(hex[i * 2 + 1] ?? "", 16);
    if (!Number.isInteger(left) || !Number.isInteger(right)) return null;
    cols.push({ left: left / 15, right: right / 15 });
  }
  return { page, head, span, cols };
}
