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

interface Family {
  name: string;
  /** First catalog index of this family. */
  start: number;
  items: SampleName[];
}

function familiesOf(list: readonly SampleName[]): Family[] {
  const out: Family[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item) continue;
    const last = out[out.length - 1];
    if (!last || last.name !== item.category) out.push({ name: item.category, start: i, items: [item] });
    else last.items.push(item);
  }
  return out;
}

const FAMILIES: Record<LaneId, readonly Family[]> = {
  kick: familiesOf(KICK_SAMPLES),
  snare: familiesOf(SNARE_SAMPLES),
  hat: familiesOf(HAT_SAMPLES),
  perc: familiesOf(PERC_SAMPLES),
  bass: familiesOf(GM_SAMPLES),
  lead: familiesOf(GM_SAMPLES),
  chords: familiesOf(GM_SAMPLES),
};

/** Fields the recording ignores. The screen hatches their digits while a sample is selected. */
const SAMPLE_IDLE: Record<LaneId, ReadonlySet<string>> = {
  kick: new Set(["body", "click", "noise"]),
  snare: new Set(["body", "noise", "noiseDecay", "snap"]),
  hat: new Set(["metal", "noise", "attack"]),
  perc: new Set(["material", "fm", "fmRatio", "attack"]),
  bass: new Set(["wave", "sync"]),
  lead: new Set(["wave", "sync"]),
  chords: new Set(["wave", "sync"]),
};

export function sampleIgnores(lane: LaneId, field: string): boolean {
  return SAMPLE_IDLE[lane].has(field);
}

export function sampleCatalog(lane: LaneId): readonly SampleName[] {
  return CATALOG[lane];
}

/** Library entries. Category index 0 is the synth, so the last family is value 1. */
export function sampleCount(lane: LaneId): number {
  return FAMILIES[lane].length;
}

/** 0 keeps the synth. 1..count selects a family. */
export function sampleIndex(unit: number, count: number): number {
  if (count < 1) return 0;
  const u = unit < 0 ? 0 : unit > 1 ? 1 : unit;
  const index = Math.round(u * count);
  if (index < 0) return 0;
  if (index > count) return count;
  return index;
}

function clampUnit(unit: number): number {
  if (unit < 0) return 0;
  if (unit > 1) return 1;
  return unit;
}

/** First recording at 0, last at 1. A family of one recording ignores the knob. */
export function instrumentIndex(unit: number, count: number): number {
  if (count <= 1) return 0;
  const index = Math.round(clampUnit(unit) * (count - 1));
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

function familyAt(lane: LaneId, categoryUnit: number): Family | null {
  const families = FAMILIES[lane];
  const index = sampleIndex(categoryUnit, families.length);
  if (index <= 0) return null;
  return families[index - 1] ?? null;
}

function clip(text: string): string {
  return text.length > 24 ? text.slice(0, 24) : text;
}

function recordingName(item: SampleName): string {
  return clip(item.take > 0 ? `${item.name} ${item.take + 1}` : item.name);
}

/** Header for the category knob. Index 0 is the procedural voice. */
export function sampleLabel(lane: LaneId, unit: number): string {
  const families = FAMILIES[lane];
  const index = sampleIndex(unit, families.length);
  if (index <= 0) return "SYNTH";
  return families[index - 1]?.name ?? "SYNTH";
}

/** Header for the instrument knob. Synth on the category leaves this reading SYNTH. */
export function instrumentLabel(lane: LaneId, categoryUnit: number, instrumentUnit: number): string {
  const family = familyAt(lane, categoryUnit);
  if (!family || family.items.length < 1) return "SYNTH";
  const item = family.items[instrumentIndex(instrumentUnit, family.items.length)];
  return item ? recordingName(item) : "SYNTH";
}

/** Category and instrument units that land on one library file. `index` 0 is the first recording. */
export function unitsForRecording(lane: LaneId, index: number): { sample: number; instrument: number } {
  const families = FAMILIES[lane];
  const list = CATALOG[lane];
  if (list.length < 1 || families.length < 1) return { sample: 0, instrument: 0 };
  let at = index;
  if (at < 0) at = 0;
  if (at >= list.length) at = list.length - 1;
  let familyIndex = families.length - 1;
  for (let i = 0; i < families.length; i++) {
    const family = families[i];
    if (family && at < family.start + family.items.length) {
      familyIndex = i;
      break;
    }
  }
  const family = families[familyIndex];
  const sample = (familyIndex + 1) / families.length;
  const offset = family ? at - family.start : 0;
  const count = family?.items.length ?? 1;
  const instrument = count > 1 ? offset / (count - 1) : 0;
  return { sample, instrument };
}

/** -1 is the synth. Otherwise the library file the two knobs resolve to. */
export function recordingIndex(lane: LaneId, categoryUnit: number, instrumentUnit: number): number {
  const families = FAMILIES[lane];
  const category = sampleIndex(categoryUnit, families.length);
  if (category <= 0) return -1;
  const family = families[category - 1];
  if (!family || family.items.length < 1) return -1;
  return family.start + instrumentIndex(instrumentUnit, family.items.length);
}

/** 0 while the category is the synth, otherwise 1..recordings in the family. */
export function instrumentNumber(lane: LaneId, categoryUnit: number, instrumentUnit: number): number {
  const family = familyAt(lane, categoryUnit);
  if (!family || family.items.length < 1) return 0;
  return instrumentIndex(instrumentUnit, family.items.length) + 1;
}

/** Synth at 0, then one detent per family. */
export function categoryDetents(lane: LaneId): number[] {
  const n = FAMILIES[lane].length;
  if (n < 1) return [0];
  const out = [0];
  for (let i = 1; i <= n; i++) out.push(i / n);
  return out;
}

export function categoryStep(lane: LaneId): number {
  const n = FAMILIES[lane].length;
  return n > 0 ? 1 / n : 1;
}

/** A detent where the instrument name changes. One recording has nowhere to stop but the start. */
export function instrumentDetents(lane: LaneId, categoryUnit: number): number[] {
  const family = familyAt(lane, categoryUnit);
  if (!family || family.items.length <= 1) return [0];
  const last = family.items.length - 1;
  const out = [0];
  for (let i = 1; i < family.items.length; i++) {
    const prev = family.items[i - 1];
    const item = family.items[i];
    if (prev && item && item.instrument !== prev.instrument) out.push(i / last);
  }
  return out;
}

export function instrumentStep(lane: LaneId, categoryUnit: number): number {
  const family = familyAt(lane, categoryUnit);
  const n = family?.items.length ?? 0;
  return n > 1 ? 1 / (n - 1) : 1;
}

/**
 * One catalog index for the engine, in the same 0..1 the bank already reads.
 * Category 0 stays the synth. Otherwise the instrument unit picks a recording inside that family.
 */
export function flatSampleUnit(lane: LaneId, categoryUnit: number, instrumentUnit: number): number {
  const total = CATALOG[lane].length;
  if (total < 1) return 0;
  const family = familyAt(lane, categoryUnit);
  if (!family || family.items.length < 1) return 0;
  const at = instrumentIndex(instrumentUnit, family.items.length);
  return (family.start + at + 1) / total;
}
