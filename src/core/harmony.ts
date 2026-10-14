import { clamp01, SIXTEENTH_TICKS } from "./clock.ts";
import { hash01 } from "./hash.ts";
import { mod } from "./motif.ts";
import {
  QUALITY_SEMITONES,
  SCALES,
  type ChordLane,
  type GlobalSettings,
  type HarmonicEvent,
  type ScaleId,
} from "./types.ts";

export function qualityIndex(mood: number, tension: number): number {
  if (tension >= 0.5) return 4 + Math.min(3, Math.floor((tension - 0.5) * 8));
  return Math.min(3, Math.floor(clamp01(mood) * 4));
}

export function pitchClassOfDegree(degree: number, scale: readonly number[], rootPc: number): number {
  const len = scale.length;
  const rounded = Math.round(degree);
  const oct = Math.floor(rounded / len);
  const idx = mod(rounded, len);
  return mod(rootPc + scale[idx] + oct * 12, 12);
}

export function degreeToMidi(degree: number, scale: readonly number[], rootPc: number, baseOctave: number): number {
  const len = scale.length;
  const rounded = Math.round(degree);
  const oct = Math.floor(rounded / len);
  const idx = mod(rounded, len);
  return baseOctave * 12 + mod(rootPc, 12) + scale[idx] + oct * 12;
}

/** Pitch classes the chord lane actually plays (chromatic quality from the scale-degree root). */
export function chordTonePitchClasses(event: HarmonicEvent, scale: readonly number[], rootPc: number): number[] {
  const rootPcOfChord = pitchClassOfDegree(event.root, scale, rootPc);
  const semis = QUALITY_SEMITONES[event.quality] ?? QUALITY_SEMITONES[0];
  return semis.map((semi) => mod(rootPcOfChord + semi, 12));
}

/**
 * Scale degrees whose pitch class matches a chord tone. Off-scale chord tones
 * (e.g. maj 3rd in a minor key) are absent — prefer {@link applyFollowMidi}.
 */
export function chordToneDegrees(event: HarmonicEvent, scale: readonly number[], rootPc: number): number[] {
  const tones = new Set(chordTonePitchClasses(event, scale, rootPc));
  const out: number[] = [];
  for (let degree = -21; degree <= 21; degree++) {
    if (tones.has(pitchClassOfDegree(degree, scale, rootPc))) out.push(degree);
  }
  return out;
}

/** follow 0 keeps the desired degree. follow 1 lands on the nearest chord degree. Ties stay on the lower one. */
export function applyFollow(desired: number, follow: number, targets: readonly number[]): number {
  if (follow <= 0 || targets.length === 0) return desired;
  let best = targets[0];
  let bestDist = Math.abs(targets[0] - desired);
  for (const target of targets) {
    const dist = Math.abs(target - desired);
    if (dist < bestDist || (dist === bestDist && target < best)) {
      best = target;
      bestDist = dist;
    }
  }
  return desired + (best - desired) * clamp01(follow);
}

/**
 * Snap a MIDI note toward the nearest pitch that matches the sounding chord.
 * Same tone set as chord audio — including chromatic chord tones off the scale.
 * Ties prefer the lower MIDI note.
 */
export function applyFollowMidi(desiredMidi: number, follow: number, chordPcs: readonly number[]): number {
  if (follow <= 0 || chordPcs.length === 0) return desiredMidi;
  let best = desiredMidi;
  let bestDist = Number.POSITIVE_INFINITY;
  const base = desiredMidi - mod(desiredMidi, 12);
  for (const pc of chordPcs) {
    for (const candidate of [base + pc - 12, base + pc, base + pc + 12]) {
      const dist = Math.abs(candidate - desiredMidi);
      if (dist < bestDist || (dist === bestDist && candidate < best)) {
        best = candidate;
        bestDist = dist;
      }
    }
  }
  return desiredMidi + (best - desiredMidi) * clamp01(follow);
}

export function harmonyAt(events: readonly HarmonicEvent[], tick: number): HarmonicEvent | null {
  let last: HarmonicEvent | null = null;
  for (const event of events) {
    if (tick < event.startTick) return last ?? event;
    last = event;
    if (tick < event.startTick + event.lengthTicks) return event;
  }
  return last;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const QUALITY_SUFFIX = ["", "m", "sus2", "sus4", "7", "m7", "dim", "aug"] as const;
const DEGREE_NUMERAL = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;

/** Note name plus a short quality, from the sounding root. */
export function chordSymbol(event: HarmonicEvent, global: GlobalSettings): string {
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  const pc = pitchClassOfDegree(event.root, scale, rootPc);
  return `${NOTE_NAMES[pc] ?? "C"}${QUALITY_SUFFIX[event.quality] ?? ""}`;
}

/** Scale degree of the chord root, wrapped into the scale, as a Roman numeral. */
export function degreeNumeral(event: HarmonicEvent, global: GlobalSettings): string {
  const scale = scaleOf(global.scale);
  const index = mod(Math.round(event.root), Math.max(1, scale.length));
  return DEGREE_NUMERAL[index] ?? String(index + 1);
}

/** Sixteenths in one bar. */
function barSixteenths(bar: number): number {
  return Math.max(1, Math.round(bar)) * 4;
}

/** 0 sixteenth, 1 eighth, 2 beat, 3 half bar, 4 bar. Duplicates stay addressable. */
function lengthUnits(barSteps: number): [number, number, number, number, number] {
  const half = Math.max(1, Math.floor(barSteps / 2));
  return [1, 2, 4, half, barSteps];
}

function gridUnits(barSteps: number): number[] {
  return [...new Set(lengthUnits(barSteps))].sort((a, b) => a - b);
}

function nextShorter(length: number, units: readonly number[]): number {
  let best = units[0] ?? 1;
  for (const unit of units) {
    if (unit < length) best = unit;
  }
  return best;
}

/**
 * Musical lengths that sum to the phrase. Variation 0 stays as even as the
 * grid allows. Above that, some chords shrink to the next shorter unit and
 * the neighbour keeps the time.
 */
export function chordLengths(
  count: number,
  lengthIndex: number,
  variation: number,
  seed: number,
  phraseSteps: number,
  bar: number,
): number[] {
  const total = Math.max(1, Math.round(phraseSteps));
  const n = Math.max(1, Math.min(16, total, Math.round(count) || 1));
  const barSteps = barSixteenths(bar);
  const units = gridUnits(barSteps);
  const picked = Math.max(0, Math.min(4, Math.round(lengthIndex)));
  const base = lengthUnits(barSteps)[picked];
  const lengths = Array.from({ length: n }, () => base);
  const sum = () => lengths.reduce((totalSteps, length) => totalSteps + length, 0);

  while (sum() > total) {
    let idx = -1;
    let best = -1;
    for (let i = 0; i < n; i++) {
      const shorter = nextShorter(lengths[i], units);
      if (shorter < lengths[i] && lengths[i] >= best) {
        best = lengths[i];
        idx = i;
      }
    }
    if (idx < 0) break;
    lengths[idx] = nextShorter(lengths[idx], units);
  }

  while (sum() < total) {
    const room = total - sum();
    let step = 0;
    for (const unit of units) {
      if (unit <= room) step = unit;
    }
    if (step <= 0) break;
    let idx = n - 1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if (lengths[i] <= best) {
        best = lengths[i];
        idx = i;
      }
    }
    lengths[idx] += step;
  }
  if (sum() < total) lengths[n - 1] += total - sum();

  const level = Math.max(0, Math.min(3, Math.round(variation)));
  if (level > 0 && n > 1) {
    const chance = level / 3;
    for (let i = 0; i < n - 1; i++) {
      if (hash01(seed, "chords", "pass", i) >= chance) continue;
      const shorter = nextShorter(lengths[i], units);
      if (shorter >= lengths[i]) continue;
      const delta = lengths[i] - shorter;
      lengths[i] = shorter;
      lengths[i + 1] += delta;
    }
  }
  return lengths;
}

function walkSign(way: number, index: number, seed: number): number {
  if (way <= 0) return 1;
  if (way === 1) return -1;
  if (way === 2) return index % 2 === 1 ? 1 : -1;
  return hash01(seed, "chords", "dir", index) < 0.5 ? -1 : 1;
}

export function generateHarmony(chords: ChordLane, global: GlobalSettings, steps: number): HarmonicEvent[] {
  const phraseSteps = Math.max(1, Math.round(global.phrase) * Math.max(1, Math.round(global.bar)) * 4);
  const span = Math.max(phraseSteps, Math.round(steps));
  const variation = Math.max(0, Math.min(3, Math.round(chords.variation)));
  const lengths = chordLengths(chords.count, chords.length, variation, global.seed, span, global.bar);
  const quality = qualityIndex(clamp01(chords.mood), clamp01(chords.tension));
  const motion = Math.max(0, Math.min(7, Math.round(chords.motion)));
  const way = Math.max(0, Math.min(3, Math.round(chords.way)));
  let degree = Math.max(-7, Math.min(7, Math.round(chords.start)));
  const events: HarmonicEvent[] = [];
  let step = 0;
  lengths.forEach((lengthSteps, index) => {
    if (index > 0) {
      const sign = walkSign(way, index, global.seed);
      const jitter = variation === 0 ? 0 : Math.round((hash01(global.seed, "chords", "jit", index) * 2 - 1) * variation);
      degree += sign * motion + jitter;
    }
    events.push({
      startTick: step * SIXTEENTH_TICKS,
      lengthTicks: Math.max(1, lengthSteps) * SIXTEENTH_TICKS,
      root: degree,
      quality,
    });
    step += lengthSteps;
  });
  return events;
}

export function scaleOf(id: ScaleId): readonly number[] {
  return SCALES[id];
}
