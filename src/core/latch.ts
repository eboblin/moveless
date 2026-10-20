import { mod } from "./motif.ts";
import { QUALITY_SEMITONES } from "./types.ts";

/** A strum inside this window becomes one chord. */
export const LATCH_SETTLE_MS = 50;

const held = new Set<number>();
let pending: { pcs: number[]; since: number } | null = null;
let latched: number[] | null = null;

export function resetLatch(): void {
  held.clear();
  pending = null;
  latched = null;
}

/** Note-on with velocity 0 releases. The same note on two channels is held separately. */
export function holdNote(channel: number, note: number, velocity: number, now: number): void {
  const id = (channel & 0xf) * 128 + (note & 0x7f);
  if (velocity > 0) held.add(id);
  else held.delete(id);
  touch(now);
}

/** All-sound-off and all-notes-off drop this channel's keys and leave the latch. */
export function releaseChannel(channel: number, now: number): void {
  const ch = channel & 0xf;
  for (const id of [...held]) {
    if ((id >> 7) === ch) held.delete(id);
  }
  touch(now);
}

/** Commit a stable held chord. An empty hand keeps the previous one. */
export function settleLatch(now: number): boolean {
  if (!pending) return false;
  if (now - pending.since < LATCH_SETTLE_MS) return false;
  const next = pending.pcs;
  pending = null;
  if (latched && same(latched, next)) return false;
  latched = next;
  return true;
}

/** Root-first pitch classes, or null before the first chord. */
export function latchedPcs(): readonly number[] | null {
  return latched;
}

export function latchStamp(): string {
  return latched ? latched.join(",") : "-";
}

/** Exact template match. The bass pitch class wins when several roots fit. */
export function matchQuality(pcs: readonly number[], bassPc?: number): { rootPc: number; quality: number } | null {
  const set = new Set(pcs.map((pc) => mod(pc, 12)));
  const hits: { rootPc: number; quality: number }[] = [];
  for (let quality = 0; quality < QUALITY_SEMITONES.length; quality++) {
    const semis = QUALITY_SEMITONES[quality];
    if (semis.length !== set.size) continue;
    for (const rootPc of set) {
      if (semis.every((semi) => set.has(mod(rootPc + semi, 12)))) hits.push({ rootPc, quality });
    }
  }
  if (bassPc !== undefined) {
    const preferred = hits.find((hit) => hit.rootPc === mod(bassPc, 12));
    if (preferred) return preferred;
  }
  return hits[0] ?? null;
}

/** Lowest sounding note is the root unless a template names another one. */
export function orderChordPcs(notes: readonly number[]): number[] {
  if (notes.length === 0) return [];
  let lowest = notes[0];
  for (const note of notes) if (note < lowest) lowest = note;
  const bass = mod(lowest, 12);
  const unique = [...new Set(notes.map((note) => mod(note, 12)))];
  const root = matchQuality(unique, bass)?.rootPc ?? bass;
  const rest = unique.filter((pc) => pc !== root).sort((a, b) => mod(a - root, 12) - mod(b - root, 12));
  return [root, ...rest];
}

function touch(now: number): void {
  const pcs = heldPcs();
  if (pcs.length === 0) {
    pending = null;
    return;
  }
  if (pending && same(pending.pcs, pcs)) return;
  pending = { pcs, since: now };
}

function heldPcs(): number[] {
  if (held.size === 0) return [];
  const notes: number[] = [];
  for (const id of held) notes.push(id & 0x7f);
  return orderChordPcs(notes);
}

function same(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
