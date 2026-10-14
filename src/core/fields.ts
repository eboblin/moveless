import type { ChordLane, DrumLane, EuclidGen, Lanes, Modulated, PitchedLane } from "./types.ts";

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
  probability: "lerp",
} as const;

const CHORD_PLAIN = {
  start: "switch",
  count: "switch",
  length: "switch",
  motion: "switch",
  variation: "switch",
  mood: "lerp",
  tension: "lerp",
  way: "switch",
  spread: "lerp",
  flow: "lerp",
  octaves: "switch",
  direction: "switch",
} as const;

export function fieldsOf(lanes: Lanes): Field[] {
  const out: Field[] = [];
  for (const id of ["kick", "snare", "hat", "perc"] as const) pushDrum(out, id, lanes[id]);
  for (const id of ["bass", "lead"] as const) pushPitched(out, id, lanes[id]);
  pushChords(out, lanes.chords);
  return out;
}

function pushMod(out: Field[], prefix: string, value: Modulated): void {
  for (const key of MOD_KEYS) {
    out.push({ path: `${prefix}.${key}`, kind: MOD_KIND[key], value: value[key] });
  }
}

function pushEuclid(out: Field[], prefix: string, gen: EuclidGen): void {
  for (const key of Object.keys(EUCLID_KIND) as (keyof typeof EUCLID_KIND)[]) {
    out.push({ path: `${prefix}.${key}`, kind: EUCLID_KIND[key], value: gen[key] });
  }
  pushMod(out, `${prefix}.velocity`, gen.velocity);
}

function pushSound(out: Field[], prefix: string, sound: Record<string, Modulated>): void {
  for (const id of Object.keys(sound).sort()) pushMod(out, `${prefix}.sound.${id}`, sound[id]);
}

function pushDrum(out: Field[], id: string, lane: DrumLane): void {
  pushEuclid(out, `${id}.gen1`, lane.gen1);
  pushEuclid(out, `${id}.gen2`, lane.gen2);
  pushMod(out, `${id}.ratchet.count`, lane.ratchet.count);
  pushMod(out, `${id}.ratchet.rate`, lane.ratchet.rate);
  pushSound(out, id, lane.sound);
}

function pushPitched(out: Field[], id: string, lane: PitchedLane): void {
  pushEuclid(out, `${id}.gen1`, lane.gen1);
  pushEuclid(out, `${id}.gen2`, lane.gen2);
  out.push({ path: `${id}.follow`, kind: "lerp", value: lane.follow });
  for (const key of ["degree", "range", "length", "repeat", "step"] as const) {
    pushMod(out, `${id}.${key}`, lane[key]);
  }
  pushSound(out, id, lane.sound);
}

function pushChords(out: Field[], lane: ChordLane): void {
  for (const key of Object.keys(CHORD_PLAIN) as (keyof typeof CHORD_PLAIN)[]) {
    out.push({ path: `chords.${key}`, kind: CHORD_PLAIN[key], value: lane[key] });
  }
  pushMod(out, "chords.rate", lane.rate);
  pushMod(out, "chords.gate", lane.gate);
  pushSound(out, "chords", lane.sound);
}

export function getPath(root: unknown, path: string): number {
  const found = walk(root, path);
  return found.value;
}

export function setPath(root: unknown, path: string, value: number): void {
  const found = walk(root, path);
  found.parent[found.key] = value;
}

function walk(root: unknown, path: string): { parent: Record<string, number>; key: string; value: number } {
  const parts = path.split(".");
  let current: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || typeof current !== "object") {
      throw new Error(`missing ${path}`);
    }
    current = (current as Record<string, unknown>)[parts[i]];
  }
  if (current === null || typeof current !== "object") throw new Error(`missing ${path}`);
  const key = parts[parts.length - 1];
  const parent = current as Record<string, number>;
  return { parent, key, value: parent[key] };
}

export function morphValue(kind: MorphKind, from: number, to: number, t: number): number {
  if (kind === "switch") return t >= 0.5 ? to : from;
  return from + (to - from) * t;
}
