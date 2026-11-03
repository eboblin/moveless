import type { EnvelopeTable } from "../dsp/envelope.ts";
import type { HarmonicEvent, LaneId, Phrase, TimedEvent } from "./types.ts";

const floatBits = new Float32Array(1);
const floatAsInt = new Int32Array(floatBits.buffer);

/** Mix one number into a running stamp. Shared by the phrase key and the envelope key. */
export function mixNum(h: number, n: number, prime: number): number {
  floatBits[0] = Number.isFinite(n) ? n : 0;
  return Math.imul(h ^ floatAsInt[0], prime) >>> 0;
}

function mixText(h: number, text: string, prime: number): number {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), prime) >>> 0;
  return h;
}

/** Two short stamps over the same walk. A hit skips cloning both lane trees. */
export function hashPair(fill: (mix: (n: number) => void, text: (s: string) => void) => void): [number, number] {
  let a = 2166136261;
  let b = 2166136261 ^ 0x9e3779b9;
  fill(
    (n) => {
      a = mixNum(a, n, 16777619);
      b = mixNum(b, n, 2246822519);
    },
    (s) => {
      a = mixText(a, s, 16777619);
      b = mixText(b, s, 2246822519);
    },
  );
  return [a, b];
}

export interface LaneBuilt {
  a: number;
  b: number;
  steps: number;
  /** Events before a voice envelope rewrites them. Envelope tables read these. */
  dry: TimedEvent[];
  events: TimedEvent[];
}

export interface PhraseMemo {
  harmonyA: number;
  harmonyB: number;
  harmony: HarmonicEvent[];
  lanes: Record<LaneId, LaneBuilt>;
  phrase: Phrase;
}

let idleA = 0;
let idleB = 0;
let idlePhrase: Phrase | null = null;

/** Phrase already built for this idle stamp, or null when the working copy moved. */
export function lookupIdle(key: readonly [number, number]): Phrase | null {
  if (key[0] === idleA && key[1] === idleB && idlePhrase) return idlePhrase;
  return null;
}

export function storeIdle(key: readonly [number, number], phrase: Phrase): Phrase {
  idleA = key[0];
  idleB = key[1];
  idlePhrase = phrase;
  return phrase;
}

let phraseMemo: PhraseMemo | null = null;

export function lookupMemo(): PhraseMemo | null {
  return phraseMemo;
}

export function storeMemo(memo: PhraseMemo): void {
  phraseMemo = memo;
}

const tablesOn = new WeakMap<Phrase, ReadonlyMap<LaneId, EnvelopeTable>>();
let bakedEnv: { stamp: number; tables: Map<LaneId, EnvelopeTable> } | null = null;
let drawnEnv: { phrase: Phrase; lane: LaneId; table: EnvelopeTable } | null = null;

/** Envelope painted while the phrase was built. The screen reads it instead of painting again. */
export function voiceTable(phrase: Phrase, lane: LaneId): EnvelopeTable | null {
  return tablesOn.get(phrase)?.get(lane) ?? null;
}

export function attachTables(phrase: Phrase, tables: ReadonlyMap<LaneId, EnvelopeTable>): void {
  tablesOn.set(phrase, tables);
}

export function lookupBaked(stamp: number): Map<LaneId, EnvelopeTable> | null {
  if (bakedEnv && bakedEnv.stamp === stamp) return bakedEnv.tables;
  return null;
}

export function storeBaked(stamp: number, tables: Map<LaneId, EnvelopeTable>): Map<LaneId, EnvelopeTable> {
  bakedEnv = { stamp, tables };
  return tables;
}

export function lookupDrawn(phrase: Phrase, lane: LaneId): EnvelopeTable | null {
  if (drawnEnv && drawnEnv.phrase === phrase && drawnEnv.lane === lane) return drawnEnv.table;
  return null;
}

export function storeDrawn(phrase: Phrase, lane: LaneId, table: EnvelopeTable): EnvelopeTable {
  drawnEnv = { phrase, lane, table };
  return table;
}

type SoundFn = (step: number) => Record<string, number>;

let soundHold: { sound: object; macros: Record<string, number>; read: SoundFn } | null = null;

/** A fresh phrase walk must not reuse a sound reader from the previous project. */
export function resetSoundHold(): void {
  soundHold = null;
}

/**
 * One reader per sound object and macro record. Identity is the key:
 * the same lane object across notes does not bind again.
 */
export function cachedSound(sound: object, macros: Record<string, number>, bind: () => SoundFn): SoundFn {
  if (!soundHold || soundHold.sound !== sound || soundHold.macros !== macros) {
    soundHold = { sound, macros, read: bind() };
  }
  return soundHold.read;
}
