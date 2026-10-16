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
  spread: "switch",
  flow: "switch",
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

function pushMod(out: Field[], prefix: string, value: Modulated, timbre: boolean): void {
  for (const key of MOD_KEYS) {
    const kind = !timbre && (key === "value" || key === "amount") ? "switch" : MOD_KIND[key];
    out.push({ path: `${prefix}.${key}`, kind, value: value[key] });
  }
}

function pushEuclid(out: Field[], prefix: string, gen: EuclidGen): void {
  for (const key of Object.keys(EUCLID_KIND) as (keyof typeof EUCLID_KIND)[]) {
    out.push({ path: `${prefix}.${key}`, kind: EUCLID_KIND[key], value: gen[key] });
  }
  pushMod(out, `${prefix}.velocity`, gen.velocity, false);
}

function pushSound(out: Field[], prefix: string, sound: Record<string, Modulated>): void {
  for (const id of Object.keys(sound).sort()) pushMod(out, `${prefix}.sound.${id}`, sound[id], true);
}

function pushDrum(out: Field[], id: string, lane: DrumLane): void {
  pushEuclid(out, `${id}.gen1`, lane.gen1);
  pushEuclid(out, `${id}.gen2`, lane.gen2);
  pushMod(out, `${id}.ratchet.count`, lane.ratchet.count, false);
  pushMod(out, `${id}.ratchet.rate`, lane.ratchet.rate, false);
  pushSound(out, id, lane.sound);
}

function pushPitched(out: Field[], id: string, lane: PitchedLane): void {
  pushEuclid(out, `${id}.gen1`, lane.gen1);
  pushEuclid(out, `${id}.gen2`, lane.gen2);
  out.push({ path: `${id}.follow`, kind: "switch", value: lane.follow });
  for (const key of ["pitch", "octave", "length", "repeat", "step"] as const) {
    pushMod(out, `${id}.${key}`, lane[key], false);
  }
  pushSound(out, id, lane.sound);
}

function pushChords(out: Field[], lane: ChordLane): void {
  for (const key of Object.keys(CHORD_PLAIN) as (keyof typeof CHORD_PLAIN)[]) {
    out.push({ path: `chords.${key}`, kind: CHORD_PLAIN[key], value: lane[key] });
  }
  pushMod(out, "chords.rate", lane.rate, false);
  pushMod(out, "chords.gate", lane.gate, false);
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
  // Discrete fields stay put until the morph lands. The heard phrase blends the whole way.
  if (kind === "switch") return t >= 1 ? to : from;
  return from + (to - from) * t;
}
