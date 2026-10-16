import {
  countFromUnit,
  rateFromUnit,
  RATES,
  sampleOffset,
  SIXTEENTH_TICKS,
  sixteenthSteps,
  swungStepTick,
  tickToSample,
} from "./clock.ts";
import { blendPhrases } from "./blend.ts";
import { generateHits, phraseStepsOf, type Hit } from "./events.ts";
import { morphEndpoints } from "./morph.ts";
import { applyFollowMidi, chordTonePitchClasses, degreeToMidi, generateHarmony, harmonyAt, pitchClassName, scaleOf } from "./harmony.ts";
import { hash01 } from "./hash.ts";
import { bipolarFromUnit, evalModulated, withMacro } from "./modulate.ts";
import { mod } from "./motif.ts";
import {
  DRUM_NOTE,
  isDrum,
  isPitched,
  LANES,
  QUALITY_SEMITONES,
  type ChordLane,
  type DrumLane,
  type GlobalSettings,
  type HarmonicEvent,
  type LaneId,
  type Lanes,
  type Phrase,
  type PitchedLane,
  type Project,
  type TimedEvent,
} from "./types.ts";

let endCache: { key: string; fromPhrase: Phrase; toPhrase: Phrase } | null = null;

const BASS_OCTAVE = 2;
const LEAD_OCTAVE = 4;
/** Pitch value walks the selected scale ± one octave (seven degrees). */
const SCALE_REACH = 7;
/**
 * Absolute tonic octave. 0 is C0 (MIDI 0). 9 is the piano's top C in this
 * numbering (MIDI 108). A0 sits in octave 1. Same ends on bass and lead.
 */
export const OCTAVE_MIN = 0;
export const OCTAVE_MAX = 9;
const CHORD_OCTAVE = 4;

export function homeOctave(lane: "bass" | "lead"): number {
  return lane === "bass" ? BASS_OCTAVE : LEAD_OCTAVE;
}

/** Unit 0 is octave 0, unit 1 is octave 9. */
export function unitForOctave(octave: number): number {
  const span = OCTAVE_MAX - OCTAVE_MIN;
  const n = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.round(octave)));
  return (n - OCTAVE_MIN) / span;
}

/** Scale degrees from the tonic. 0.5 is the tonic, the edges are one octave of the scale away. */
export function scaleOffset(unit: number): number {
  const u = Math.max(0, Math.min(1, unit));
  return Math.round((u - 0.5) * (SCALE_REACH * 2));
}

/** Absolute octave of the tonic, 0..9. */
export function octaveNumber(unit: number): number {
  const u = Math.max(0, Math.min(1, unit));
  return OCTAVE_MIN + Math.round(u * (OCTAVE_MAX - OCTAVE_MIN));
}

/** Resting scale note for the pitch knob, before pattern motion and follow. */
export function restingPitchLabel(lane: "bass" | "lead", pitch: number, octave: number, global: GlobalSettings): string {
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  const degree = scaleOffset(pitch);
  const midi = degreeToMidi(degree, scale, rootPc, octaveNumber(octave));
  return noteLabel(midi);
}

function noteLabel(midi: number): string {
  const note = Math.max(0, Math.min(127, Math.round(midi)));
  return `${pitchClassName(note)}${Math.floor(note / 12)}`;
}

export function restingOctave(octave: number): number {
  return octaveNumber(octave);
}

export function generatePhrase(project: Project): Phrase {
  const morph = project.morph;
  const target = morph ? project.journal.find((scene) => scene.id === morph.targetId) : undefined;
  if (!morph || !target) return phraseOf(project, project.working);
  const ends = morphEndpoints(project, target.lanes);
  const key = JSON.stringify([ends.from, ends.to, project.macros, project.global]);
  if (!endCache || endCache.key !== key) {
    endCache = {
      key,
      fromPhrase: phraseOf(project, ends.from),
      toPhrase: phraseOf(project, ends.to),
    };
  }
  return blendPhrases(endCache.fromPhrase, endCache.toPhrase, ends.from, ends.to, project, morph.t);
}

function phraseOf(project: Project, working: Lanes): Phrase {
  const { global, macros, lock } = project;
  const bassSteps = laneSteps(working, "bass", global);
  const leadSteps = laneSteps(working, "lead", global);
  const chordSteps = sixteenthSteps(global.phrase, global.bar);
  const harmony = generateHarmony(working.chords, global, Math.max(bassSteps, leadSteps, chordSteps));
  const lanes = {} as Phrase["lanes"];
  const steps = {} as Phrase["steps"];
  for (const lane of LANES) {
    steps[lane] = laneSteps(working, lane, global);
    lanes[lane] = eventsFor(working, lane, global, lock[lane] ? {} : macros, harmony, steps[lane]);
  }
  return { lanes, harmony, steps };
}

export const previewPhrase = generatePhrase;

export function laneSteps(lanes: Lanes, lane: LaneId, global: GlobalSettings): number {
  if (lane === "chords") return sixteenthSteps(global.phrase, global.bar);
  // Bass/lead must loop over the chord phrase, or follow only ever sees the
  // first harmony block while chords keep changing underneath.
  if (lane === "bass" || lane === "lead") {
    return Math.max(phraseStepsOf(lanes[lane].gen1, lanes[lane].gen2), sixteenthSteps(global.phrase, global.bar));
  }
  return phraseStepsOf(lanes[lane].gen1, lanes[lane].gen2);
}

function eventsFor(
  lanes: Lanes,
  lane: LaneId,
  global: GlobalSettings,
  macros: Record<string, number>,
  harmony: HarmonicEvent[],
  steps: number,
): TimedEvent[] {
  if (isDrum(lane)) return drumEvents(lanes[lane], lane, global, macros, steps);
  if (isPitched(lane)) return pitchedEvents(lanes[lane], lane, global, macros, harmony, steps);
  return chordAudio(lanes.chords, harmony, global, macros, lanes.chords.sound);
}

function macro(macros: Record<string, number>, id: string): number {
  return macros[id] ?? 0;
}

function soundValues(
  sound: Record<string, { value: number; pattern: number; cycle: number; amount: number }>,
  step: number,
  macros: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(sound)) out[id] = evalModulated(withMacro(sound[id], macro(macros, id)), step);
  return out;
}

function place(step: number, extraTicks: number, global: GlobalSettings, lane: LaneId, note: number, velocity: number, lengthTicks: number, sound: Record<string, number>): TimedEvent {
  const tick = swungStepTick(step, global.swing) + extraTicks;
  const sample = tickToSample(tick, global.tempo);
  return {
    lane,
    tick,
    sample,
    sampleOffset: sampleOffset(sample),
    note,
    velocity,
    lengthTicks,
    step,
    sound,
  };
}

function drumEvents(lane: DrumLane, id: LaneId, global: GlobalSettings, macros: Record<string, number>, steps: number): TimedEvent[] {
  const hits = generateHits(lane.gen1, lane.gen2, steps, global.seed, id, macro(macros, "velocity"), macro(macros, "probability"));
  const out: TimedEvent[] = [];
  hits.forEach((hit) => {
    const count = countFromUnit(evalModulated(withMacro(lane.ratchet.count, macro(macros, "count") + macro(macros, "repeat")), hit.step));
    const rate = rateFromUnit(evalModulated(withMacro(lane.ratchet.rate, macro(macros, "rate")), hit.step));
    for (let i = 0; i < count; i++) {
      const step = hit.step + (i * rate.ticks) / SIXTEENTH_TICKS;
      const sound = soundValues(lane.sound, step, macros);
      out.push(place(hit.step, i * rate.ticks, global, id, DRUM_NOTE[id as keyof typeof DRUM_NOTE], hit.velocity, rate.ticks, sound));
    }
  });
  return out;
}

function pitchedEvents(
  lane: PitchedLane,
  id: "bass" | "lead",
  global: GlobalSettings,
  macros: Record<string, number>,
  harmony: HarmonicEvent[],
  steps: number,
): TimedEvent[] {
  const hits = generateHits(lane.gen1, lane.gen2, steps, global.seed, id, macro(macros, "velocity"), macro(macros, "probability"));
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  const out: TimedEvent[] = [];
  hits.forEach((hit) => {
    const reps = countFromUnit(evalModulated(withMacro(lane.repeat, macro(macros, "repeat")), hit.step));
    const shift = Math.round(bipolarFromUnit(evalModulated(withMacro(lane.step, macro(macros, "step")), hit.step), 7));
    for (let r = 0; r < reps; r++) {
      const step = hit.step + r;
      const pitchU = evalModulated(withMacro(lane.pitch, macro(macros, "pitch")), step);
      const octaveU = evalModulated(withMacro(lane.octave, macro(macros, "octave")), step);
      const degree = scaleOffset(pitchU) + r * shift;
      const desiredMidi = degreeToMidi(degree, scale, rootPc, octaveNumber(octaveU));
      const tick = swungStepTick(step, global.swing);
      const harm = harmonyAt(harmony, tick);
      const chordPcs = harm ? chordTonePitchClasses(harm, scale, rootPc) : [];
      const note = Math.max(0, Math.min(127, Math.round(applyFollowMidi(desiredMidi, lane.follow, chordPcs))));
      const lengthTicks = Math.max(1, Math.round(evalModulated(withMacro(lane.length, macro(macros, "length")), step) * global.bar * SIXTEENTH_TICKS));
      const sound = soundValues(lane.sound, step, macros);
      out.push(place(hit.step, r * SIXTEENTH_TICKS, global, id, note, hit.velocity, lengthTicks, sound));
    }
  });
  return out;
}

export interface ChordFigure {
  mode: "block" | "arp";
  ticks: number;
  /** Header while the rate value knob is held. */
  label: string;
}

/** 0 is a block chord. Above that, the rate table runs from 1/8 to 1/64 as an arp. */
export function chordFigure(unit: number): ChordFigure {
  if (unit <= 0) return { mode: "block", ticks: 0, label: "BLOCK" };
  const index = Math.min(RATES.length - 1, Math.floor(Math.min(1, unit) * RATES.length));
  const rate = RATES[index] ?? RATES[0];
  return { mode: "arp", ticks: rate.ticks, label: rate.id };
}

/** 0 up, 1 down, 2 alternate chords, 3 up-down, 4 down-up, 5 in, 6 out, 7 random. */
const DIRECTION_LABEL = ["UP", "DOWN", "ALT", "UP DOWN", "DOWN UP", "IN", "OUT", "RAND"] as const;

export function directionLabel(direction: number): string {
  const index = Math.max(0, Math.min(DIRECTION_LABEL.length - 1, Math.round(direction)));
  return DIRECTION_LABEL[index] ?? "UP";
}

/** Order the chord tones for one arp cycle. */
export function chordOrder(notes: readonly number[], direction: number, chordIndex: number, seed: number): number[] {
  const dir = Math.max(0, Math.min(DIRECTION_LABEL.length - 1, Math.round(direction)));
  let ordered = notes.slice();
  if (dir === 1 || (dir === 2 && chordIndex % 2 === 1)) ordered.reverse();
  else if (dir === 4) ordered.reverse();
  else if (dir === 5) ordered = endsFirst(ordered);
  else if (dir === 6) ordered = middleFirst(ordered);
  else if (dir === 7) ordered = shuffled(ordered, seed, chordIndex);
  if (dir === 3 || dir === 4) ordered = withReturn(ordered);
  return ordered;
}

function withReturn(notes: number[]): number[] {
  if (notes.length < 3) return notes;
  return notes.concat(notes.slice(1, -1).reverse());
}

function endsFirst(notes: number[]): number[] {
  const out: number[] = [];
  let lo = 0;
  let hi = notes.length - 1;
  while (lo <= hi) {
    out.push(notes[lo]);
    lo += 1;
    if (lo <= hi) {
      out.push(notes[hi]);
      hi -= 1;
    }
  }
  return out;
}

function middleFirst(notes: number[]): number[] {
  const n = notes.length;
  const mid = Math.floor((n - 1) / 2);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const mag = Math.ceil(k / 2);
    const index = k % 2 === 0 ? mid - mag : mid + mag;
    const note = notes[index];
    if (note !== undefined) out.push(note);
  }
  return out;
}

function shuffled(notes: number[], seed: number, chordIndex: number): number[] {
  const out = notes.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed, "chords", "order", chordIndex, i) * (i + 1));
    const swap = out[i];
    out[i] = out[j] ?? out[i];
    out[j] = swap;
  }
  return out;
}

function chordAudio(
  lane: ChordLane,
  harmony: HarmonicEvent[],
  global: GlobalSettings,
  macros: Record<string, number>,
  sound: ChordLaneSound,
): TimedEvent[] {
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  const octaves = Math.max(1, Math.round(lane.octaves));
  const out: TimedEvent[] = [];
  harmony.forEach((harm, index) => {
    const voiced = voices(harm, scale, rootPc, lane, octaves);
    const ordered = chordOrder(voiced, lane.direction, index, global.seed);
    const hits = walkChord(harm, voiced, ordered, (tick) => {
      const step = tick / SIXTEENTH_TICKS;
      const rateU = evalModulated(withMacro(lane.rate, macro(macros, "rate")), step);
      const gateU = evalModulated(withMacro(lane.gate, macro(macros, "gate")), step);
      return { ...chordFigure(rateU), gate: gateU };
    });
    hits.forEach(({ note, delay, lengthTicks }) => {
      const start = harm.startTick + delay;
      const rendered = soundValues(sound, start / SIXTEENTH_TICKS, macros);
      const sample = tickToSample(start, global.tempo);
      out.push({
        lane: "chords",
        tick: start,
        sample,
        sampleOffset: sampleOffset(sample),
        note,
        velocity: 0.85,
        lengthTicks,
        step: Math.floor(harm.startTick / SIXTEENTH_TICKS),
        sound: rendered,
      });
    });
  });
  return out;
}

type FigureAt = ChordFigure & { gate: number };

/**
 * Rate and gate are read once per note, so the figure follows their envelopes
 * at the resolution the pattern is drawn. A block is rechecked each sixteenth.
 */
function walkChord(
  harm: HarmonicEvent,
  voiced: readonly number[],
  ordered: readonly number[],
  at: (tick: number) => FigureAt,
): { note: number; delay: number; lengthTicks: number }[] {
  const length = harm.lengthTicks;
  const hits: { note: number; delay: number; lengthTicks: number }[] = [];
  let cursor = 0;
  let voice = 0;
  let mode: FigureAt["mode"] | null = null;
  while (cursor < length) {
    const now = at(harm.startTick + cursor);
    if (now.mode !== mode) {
      voice = 0;
      mode = now.mode;
    }
    if (now.mode === "block" || now.ticks <= 0) {
      const end = blockEnd(cursor, length, harm.startTick, at);
      voiced.forEach((note) => hits.push({ note, delay: cursor, lengthTicks: Math.max(1, end - cursor) }));
      cursor = end;
      mode = null;
      continue;
    }
    if (ordered.length === 0) break;
    const note = ordered[voice % ordered.length];
    if (note === undefined) break;
    const step = Math.max(1, now.ticks);
    const next = Math.min(length, cursor + step);
    const gateTicks = Math.max(1, Math.round(step * clampGate(now.gate)));
    const room = Math.max(1, Math.min(gateTicks, next - cursor, length - cursor));
    hits.push({ note, delay: cursor, lengthTicks: room });
    voice += 1;
    cursor = next;
  }
  return hits;
}

/** Leave a block on the sixteenth where rate steps out of it. */
function blockEnd(cursor: number, length: number, start: number, at: (tick: number) => FigureAt): number {
  let tick = Math.min(length, cursor + SIXTEENTH_TICKS);
  while (tick < length) {
    const later = at(start + tick);
    if (later.mode !== "block" && later.ticks > 0) return tick;
    tick = Math.min(length, tick + SIXTEENTH_TICKS);
  }
  return length;
}

type ChordLaneSound = Parameters<typeof soundValues>[0];

function voices(harm: HarmonicEvent, scale: readonly number[], rootPc: number, lane: ChordLane, octaves: number): number[] {
  const rootPitch = pitchOf(harm.root, scale, rootPc);
  const semis = QUALITY_SEMITONES[harm.quality] ?? QUALITY_SEMITONES[0];
  let notes: number[] = [];
  for (let oct = 0; oct < octaves; oct++) {
    semis.forEach((semi, voice) => {
      const spread = voice % 2 === 1 ? Math.round(lane.spread) : 0;
      notes.push(CHORD_OCTAVE * 12 + rootPitch + semi + (oct + spread) * 12);
    });
  }
  if (lane.flow > 0 && notes.length > 1) {
    const pull = Math.round((lane.flow - 0.5) * 2);
    notes = notes.map((note, i) => note + (i - (notes.length - 1) / 2) * pull);
  }
  return notes;
}

function pitchOf(degree: number, scale: readonly number[], rootPc: number): number {
  return degreeToMidi(degree, scale, rootPc, 0);
}

function clampGate(gate: number): number {
  if (gate < 0.05) return 0.05;
  if (gate > 1) return 1;
  return gate;
}

export function hitsOn(phrase: Phrase, lane: LaneId): number[] {
  return [...new Set(phrase.lanes[lane].map((event) => event.step))].sort((a, b) => a - b);
}

export type { Hit };
