import type { ChordLane, DrumLane, EuclidGen, LaneFilter, LaneId, LaneSend, Lanes, Modulated, PitchedLane } from "./types.ts";

export type MorphKind = "lerp" | "switch";

export interface Field {
  path: string;
  kind: MorphKind;
  value: number;
}

const MOD_KEYS = ["value", "pattern", "cycle", "amount"] as const;
const MOD_KIND: Record<(typeof MOD_KEYS)[number], MorphKind> = {
  value: "lerp",
  pattern: "switch",
  cycle: "switch",
  amount: "lerp",
};

const EUCLID_KIND = {
  length: "switch",
  hits: "switch",
  rotate: "switch",
  probability: "switch",
} as const;

const CHORD_PLAIN = {
  start: "switch",
  count: "switch",
  length: "switch",
  motion: "switch",
  variation: "switch",
  mood: "switch",
  tension: "switch",
  way: "switch",
} as const;

type Sink = (path: string, kind: MorphKind, value: number) => void;

function emitMod(sink: Sink, prefix: string, value: Modulated, timbre: boolean): void {
  for (const key of MOD_KEYS) {
    const kind = !timbre && (key === "value" || key === "amount") ? "switch" : MOD_KIND[key];
    sink(`${prefix}.${key}`, kind, value[key]);
  }
}

function emitEuclid(sink: Sink, prefix: string, gen: EuclidGen): void {
  for (const key of Object.keys(EUCLID_KIND) as (keyof typeof EUCLID_KIND)[]) {
    sink(`${prefix}.${key}`, EUCLID_KIND[key], gen[key]);
  }
  emitMod(sink, `${prefix}.velocity`, gen.velocity, false);
}

function emitSound(sink: Sink, prefix: string, sound: Record<string, Modulated>): void {
  for (const id of Object.keys(sound).sort()) emitMod(sink, `${prefix}.sound.${id}`, sound[id], true);
}

function emitFilter(sink: Sink, prefix: string, filter: LaneFilter): void {
  emitMod(sink, `${prefix}.filter.cutoff`, filter.cutoff, true);
  emitMod(sink, `${prefix}.filter.resonance`, filter.resonance, true);
}

function emitSend(sink: Sink, prefix: string, send: LaneSend): void {
  emitMod(sink, `${prefix}.send.reverb`, send.reverb, true);
  emitMod(sink, `${prefix}.send.delay`, send.delay, true);
}

function emitDrum(sink: Sink, id: string, lane: DrumLane): void {
  emitEuclid(sink, `${id}.gen1`, lane.gen1);
  emitEuclid(sink, `${id}.gen2`, lane.gen2);
  emitMod(sink, `${id}.ratchet.count`, lane.ratchet.count, false);
  emitMod(sink, `${id}.ratchet.rate`, lane.ratchet.rate, false);
  emitSound(sink, id, lane.sound);
  emitFilter(sink, id, lane.filter);
  emitSend(sink, id, lane.send);
}

function emitPitched(sink: Sink, id: string, lane: PitchedLane): void {
  emitEuclid(sink, `${id}.gen1`, lane.gen1);
  emitEuclid(sink, `${id}.gen2`, lane.gen2);
  sink(`${id}.follow`, "switch", lane.follow);
  for (const key of ["pitch", "octave", "length", "repeat", "step"] as const) {
    emitMod(sink, `${id}.${key}`, lane[key], false);
  }
  emitSound(sink, id, lane.sound);
  emitFilter(sink, id, lane.filter);
  emitSend(sink, id, lane.send);
}

function emitChords(sink: Sink, lane: ChordLane): void {
  for (const key of Object.keys(CHORD_PLAIN) as (keyof typeof CHORD_PLAIN)[]) {
    sink(`chords.${key}`, CHORD_PLAIN[key], lane[key]);
  }
  emitMod(sink, "chords.tone", lane.tone, false);
  emitMod(sink, "chords.octave", lane.octave, false);
  emitMod(sink, "chords.rate", lane.rate, false);
  emitMod(sink, "chords.gate", lane.gate, false);
  emitSound(sink, "chords", lane.sound);
  emitFilter(sink, "chords", lane.filter);
  emitSend(sink, "chords", lane.send);
}

function walkLanes(lanes: Lanes, sink: Sink, only?: LaneId): void {
  if (!only || only === "kick") emitDrum(sink, "kick", lanes.kick);
  if (!only || only === "snare") emitDrum(sink, "snare", lanes.snare);
  if (!only || only === "hat") emitDrum(sink, "hat", lanes.hat);
  if (!only || only === "perc") emitDrum(sink, "perc", lanes.perc);
  if (!only || only === "bass") emitPitched(sink, "bass", lanes.bass);
  if (!only || only === "lead") emitPitched(sink, "lead", lanes.lead);
  if (!only || only === "chords") emitChords(sink, lanes.chords);
}

export function fieldsOf(lanes: Lanes): Field[] {
  const out: Field[] = [];
  walkLanes(lanes, (path, kind, value) => out.push({ path, kind, value }));
  return out;
}

/** Mix field values into a stamp. No Field objects. */
export function mixFieldValues(lanes: Lanes, mix: (n: number) => void, only?: LaneId): void {
  walkLanes(lanes, (_path, _kind, value) => mix(value), only);
}

/** Dotted path. Missing nodes are `undefined`; callers that require a number use {@link getPath}. */
export function nodeAt(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function getPath(root: unknown, path: string): number {
  const value = nodeAt(root, path);
  if (typeof value !== "number") throw new Error(`missing ${path}`);
  return value;
}

export function setPath(root: unknown, path: string, value: number): void {
  const parts = path.split(".");
  const key = parts.pop();
  if (!key) throw new Error(`missing ${path}`);
  const parent = parts.length ? nodeAt(root, parts.join(".")) : root;
  if (parent === null || typeof parent !== "object") throw new Error(`missing ${path}`);
  (parent as Record<string, number>)[key] = value;
}

export function morphValue(kind: MorphKind, from: number, to: number, t: number): number {
  // Discrete fields stay put until the morph lands. The heard phrase blends the whole way.
  if (kind === "switch") return t >= 1 ? to : from;
  return from + (to - from) * t;
}
