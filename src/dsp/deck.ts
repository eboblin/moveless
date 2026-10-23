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
    down: 0,
    up: null,
    warm: false,
    seed: 1,
    barBeats: 4,
    ringL: new Float32Array(RING),
    ringR: new Float32Array(RING),
    mask: RING - 1,
    filled: 0,
    lead: 0,
    bypass: false,
  };
}

export function deckTargetLead(tempo: number, barBeats: number): number {
  return Math.min(RING >> 1, barSamples(tempo, barBeats));
}

/** Remember a command. A new gesture grabs the clock; letting go only arms the fade. */
export function commandDeck(deck: DeckRuntime, gesture: DeckGesture | null, clock: number): void {
  if (gesture === deck.command) return;
  deck.command = gesture;
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
