import { clamp01, SIXTEENTH_TICKS } from "./clock.ts";
import { hash01 } from "./hash.ts";
import { evalModulated, withMacro } from "./modulate.ts";
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

export function generateHarmony(
  chords: ChordLane,
  global: GlobalSettings,
  steps: number,
  macros: Record<string, number> = {},
): HarmonicEvent[] {
  const phraseSteps = Math.max(1, Math.round(global.phrase) * Math.max(1, Math.round(global.bar)) * 4);
  const span = Math.max(phraseSteps, steps);
  const events: HarmonicEvent[] = [];
  let step = 0;
  let root = 0;
  let index = 0;
  while (step < span && index < 512) {
    const changeU = evalModulated(withMacro(chords.change, macros.change ?? 0), step);
    const lengthU = evalModulated(withMacro(chords.length, macros.length ?? 0), step);
    const motionU = evalModulated(withMacro(chords.motion, macros.motion ?? 0), step);
    const varU = evalModulated(withMacro(chords.variation, macros.variation ?? 0), step);
    const moodU = evalModulated(withMacro(chords.mood, macros.mood ?? 0), step);
    const tensionU = evalModulated(withMacro(chords.tension, macros.tension ?? 0), step);
    const minInterval = 4;
    const interval = Math.max(minInterval, Math.round(phraseSteps - (phraseSteps - minInterval) * changeU));
    if (index > 0) {
      const leap = Math.round(motionU * 3);
      const dir = hash01(global.seed, "chords", "dir", index) < 0.5 ? -1 : 1;
      const jitter = Math.round((hash01(global.seed, "chords", "jit", index) * 2 - 1) * varU * 2);
      root += dir * leap + jitter;
    }
    const lengthSteps = Math.max(1, Math.round(interval * clamp01(0.25 + 0.75 * lengthU)));
    events.push({
      startTick: step * SIXTEENTH_TICKS,
      lengthTicks: lengthSteps * SIXTEENTH_TICKS,
      root,
      quality: qualityIndex(moodU, tensionU),
    });
    step += interval;
    index++;
  }
  return events;
}

export function scaleOf(id: ScaleId): readonly number[] {
  return SCALES[id];
}
