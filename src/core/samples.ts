import type { LaneId } from "./types.ts";
import {
  GM_SAMPLES,
  HAT_SAMPLES,
  KICK_SAMPLES,
  PERC_SAMPLES,
  SNARE_SAMPLES,
  type SampleName,
} from "./sample-catalog.ts";

const CATALOG: Record<LaneId, readonly SampleName[]> = {
  kick: KICK_SAMPLES,
  snare: SNARE_SAMPLES,
  hat: HAT_SAMPLES,
  perc: PERC_SAMPLES,
  bass: GM_SAMPLES,
  lead: GM_SAMPLES,
  chords: GM_SAMPLES,
};

export function sampleCatalog(lane: LaneId): readonly SampleName[] {
  return CATALOG[lane];
}

/** Library entries. Knob index 0 is the synth, so the last entry is value 1. */
export function sampleCount(lane: LaneId): number {
  return CATALOG[lane].length;
}

/** 0 keeps the synth. 1..count selects a library entry. */
export function sampleIndex(unit: number, count: number): number {
  if (count < 1) return 0;
  const u = unit < 0 ? 0 : unit > 1 ? 1 : unit;
  const index = Math.round(u * count);
  if (index < 0) return 0;
  if (index > count) return count;
  return index;
}

/** Header while the encoder is held. Index 0 is the procedural voice. */
export function sampleLabel(lane: LaneId, unit: number): string {
  const list = CATALOG[lane];
  const index = sampleIndex(unit, list.length);
  if (index <= 0) return "SYNTH";
  const item = list[index - 1];
  if (!item) return "SYNTH";
  const text = item.take > 0 ? `${item.name} ${item.take + 1}` : item.name;
  return text.length > 24 ? text.slice(0, 24) : text;
}

/** Synth at 0, then the first take of each bank or GM key. */
export function sampleDetents(lane: LaneId): number[] {
  const list = CATALOG[lane];
  const n = list.length;
  if (n < 1) return [0];
  const out = [0];
  for (let i = 0; i < list.length; i++) {
    if (list[i].take === 0) out.push((i + 1) / n);
  }
  return out;
}

export function sampleStep(lane: LaneId): number {
  const n = CATALOG[lane].length;
  return n > 0 ? 1 / n : 1;
}
