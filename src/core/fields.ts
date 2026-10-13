import type { ChordLane, DrumLane, Lanes, Modulated, PitchedLane } from "./types.ts";

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

const GEN_KEYS = ["level", "cycle", "offset"] as const;
const GEN_KIND: Record<(typeof GEN_KEYS)[number], MorphKind> = {
  level: "lerp",
  cycle: "switch",
  offset: "switch",
};

const FORM_KIND = {
  length: "switch",
  abSplit: "lerp",
  repeats: "switch",
  varEvery: "switch",
  varDiv: "switch",
  varCount: "switch",
  varAmount: "lerp",
  follow: "lerp",
} as const;

const PLAY_KIND = {
  mode: "switch",
  rate: "switch",
  gate: "lerp",
  octaves: "switch",
  spread: "lerp",
  flow: "lerp",
  strum: "lerp",
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

function pushEvents(out: Field[], prefix: string, events: DrumLane["events"]): void {
  for (const part of ["a", "b"] as const) {
    for (const gen of ["g1", "g2"] as const) {
      for (const key of GEN_KEYS) {
        out.push({
          path: `${prefix}.events.${part}.${gen}.${key}`,
          kind: GEN_KIND[key],
          value: events[part][gen][key],
        });
      }
    }
  }
}

function pushForm(out: Field[], prefix: string, form: DrumLane["form"]): void {
  for (const key of Object.keys(FORM_KIND) as (keyof typeof FORM_KIND)[]) {
    out.push({ path: `${prefix}.form.${key}`, kind: FORM_KIND[key], value: form[key] });
  }
}

function pushSound(out: Field[], prefix: string, sound: Record<string, Modulated>): void {
  for (const id of Object.keys(sound).sort()) pushMod(out, `${prefix}.sound.${id}`, sound[id]);
}

function pushDrum(out: Field[], id: string, lane: DrumLane): void {
  pushEvents(out, id, lane.events);
  pushForm(out, id, lane.form);
  pushMod(out, `${id}.ratchet.count`, lane.ratchet.count);
  pushMod(out, `${id}.ratchet.rate`, lane.ratchet.rate);
  pushSound(out, id, lane.sound);
}

function pushPitched(out: Field[], id: string, lane: PitchedLane): void {
  pushEvents(out, id, lane.events);
  pushForm(out, id, lane.form);
  for (const key of ["degree", "range", "length", "velocity", "repeat", "step"] as const) {
    pushMod(out, `${id}.${key}`, lane[key]);
  }
  pushSound(out, id, lane.sound);
}

function pushChords(out: Field[], lane: ChordLane): void {
  for (const key of ["change", "length", "motion", "variation", "mood", "tension"] as const) {
    pushMod(out, `chords.${key}`, lane[key]);
  }
  for (const key of Object.keys(PLAY_KIND) as (keyof typeof PLAY_KIND)[]) {
    out.push({ path: `chords.play.${key}`, kind: PLAY_KIND[key], value: lane.play[key] });
  }
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
