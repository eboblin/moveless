import {
  countFromUnit,
  rateFromUnit,
  CHORD_RATES,
  sampleOffset,
  SIXTEENTH_TICKS,
  sixteenthSteps,
  swungStepTick,
  tickToSample,
} from "./clock.ts";
import { blendPhrases } from "./blend.ts";
import { generateHits, phraseStepsOf, type Hit } from "./events.ts";
import { fieldsOf, getPath } from "./fields.ts";
import { morphEndpoints } from "./morph.ts";
import { applyFollowMidi, chordTonePitchClasses, degreeToMidi, generateHarmony, harmonyAt, pitchClassName, scaleOf } from "./harmony.ts";
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
  type Scene,
  type TimedEvent,
} from "./types.ts";

interface EndSnap {
  a: number;
  b: number;
  from: Lanes;
  to: Lanes;
  fromPhrase: Phrase;
  toPhrase: Phrase;
}

let endCache: EndSnap | null = null;
let idleProject: Project | null = null;
let idleA = 0;
let idleB = 0;
let idlePhrase: Phrase | null = null;

const floatBits = new Float32Array(1);
const floatAsInt = new Int32Array(floatBits.buffer);

function mixNum(h: number, n: number, prime: number): number {
  floatBits[0] = Number.isFinite(n) ? n : 0;
  return Math.imul(h ^ floatAsInt[0], prime) >>> 0;
}

function mixText(h: number, text: string, prime: number): number {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), prime) >>> 0;
  return h;
}

/** Two short stamps over the same walk. A hit skips cloning both lane trees. */
function stampPair(fill: (mix: (n: number) => void, text: (s: string) => void) => void): [number, number] {
  let a = 2166136261;
  let b = 2166136261 ^ 0x9e3779b9;
  fill(
    (n) => {
      a = mixNum(a, n, 16777619);
      b = mixNum(b, n, 2246822519);
    },
    (s) => {
      a = mixText(a, s, 16777619);
      b = mixText(b, s, 2246822519);
    },
  );
  return [a, b];
}

function stampLanes(mix: (n: number) => void, lanes: Lanes, lane?: LaneId): void {
  const prefix = lane ? `${lane}.` : "";
  for (const field of fieldsOf(lanes)) {
    if (prefix && !field.path.startsWith(prefix)) continue;
    mix(field.value);
  }
}

function stampGlobal(mix: (n: number) => void, text: (s: string) => void, project: Project): void {
  const global = project.global;
  mix(global.tempo);
  mix(global.swing);
  mix(global.root);
  text(global.scale);
  mix(global.transpose);
  mix(global.bar);
  mix(global.phrase);
  mix(global.seed);
  const macros = Object.keys(project.macros).sort();
  for (const id of macros) {
    text(id);
    mix(project.macros[id] ?? 0);
  }
  for (const lane of LANES) mix(project.lock[lane] ? 1 : 0);
}

function idleStamp(project: Project): [number, number] {
  return stampPair((mix, text) => {
    stampLanes(mix, project.working);
    stampGlobal(mix, text, project);
  });
}

function endStamp(project: Project, target: Lanes): [number, number] {
  const morph = project.morph;
  const start = morph?.start ?? project.working;
  return stampPair((mix, text) => {
    stampLanes(mix, start);
    stampLanes(mix, target);
    stampGlobal(mix, text, project);
    for (const lane of LANES) {
      if (!project.lock[lane]) continue;
      text(lane);
      stampLanes(mix, project.working, lane);
    }
    for (const path of morph?.punched ?? []) {
      text(path);
      mix(getPath(project.working, path));
    }
  });
}

function ensureEnds(project: Project, target: Lanes): EndSnap {
  const [a, b] = endStamp(project, target);
  if (endCache && endCache.a === a && endCache.b === b) return endCache;
  const ends = morphEndpoints(project, target);
  endCache = {
    a,
    b,
    from: ends.from,
    to: ends.to,
    fromPhrase: phraseOf(project, ends.from),
    toPhrase: phraseOf(project, ends.to),
  };
  return endCache;
}

/** Lane trees for the live morph, cloned only when the endpoint stamp misses. */
export function endpointLanes(project: Project): { from: Lanes; to: Lanes } | null {
  const target = morphTarget(project);
  if (!target) return null;
  const snap = ensureEnds(project, target.lanes);
  return { from: snap.from, to: snap.to };
}

function morphTarget(project: Project): Scene | undefined {
  const morph = project.morph;
  if (!morph) return undefined;
  return project.journal.find((scene) => scene.id === morph.targetId);
}

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

/** 0 picks the root, 1 picks the top tone of this chord. */
export function chordToneIndex(unit: number, count: number): number {
  const n = Math.max(1, Math.round(count));
  if (n <= 1) return 0;
  const u = Math.max(0, Math.min(1, unit));
  return Math.round(u * (n - 1));
}

/** Resting note of the chord tone knob: first chord, value only, no pattern. */
export function restingChordToneLabel(lane: ChordLane, global: GlobalSettings): string {
  const steps = sixteenthSteps(global.phrase, global.bar);
  const harm = generateHarmony(lane, global, steps)[0];
  if (!harm) return "—";
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  return noteLabel(chordToneMidi(harm, scale, rootPc, lane.tone.value, lane.octave.value));
}

function chordVoices(harm: HarmonicEvent, scale: readonly number[], rootPc: number, octaveUnit: number): number[] {
  const semis = QUALITY_SEMITONES[harm.quality] ?? QUALITY_SEMITONES[0];
  const base = octaveNumber(octaveUnit) * 12 + degreeToMidi(harm.root, scale, rootPc, 0);
  return semis.map((semi) => base + semi);
}

function chordToneMidi(
  harm: HarmonicEvent,
  scale: readonly number[],
  rootPc: number,
  toneUnit: number,
  octaveUnit: number,
): number {
  const voices = chordVoices(harm, scale, rootPc, octaveUnit);
  return voices[chordToneIndex(toneUnit, voices.length)] ?? voices[0] ?? 0;
}

export function generatePhrase(project: Project): Phrase {
  const target = morphTarget(project);
  if (!project.morph || !target) {
    const [a, b] = idleStamp(project);
    if (project === idleProject && a === idleA && b === idleB && idlePhrase) return idlePhrase;
    const phrase = phraseOf(project, project.working);
    idleProject = project;
    idleA = a;
    idleB = b;
    idlePhrase = phrase;
    return phrase;
  }
  const snap = ensureEnds(project, target.lanes);
  return blendPhrases(snap.fromPhrase, snap.toPhrase, snap.from, snap.to, project, project.morph.t);
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

/** 0 is a block chord. Above that, the chord rate table runs from 1/1 to 1/64 as an arp. */
export function chordFigure(unit: number): ChordFigure {
  if (unit <= 0) return { mode: "block", ticks: 0, label: "BLOCK" };
  const index = Math.min(CHORD_RATES.length - 1, Math.floor(Math.min(1, unit) * CHORD_RATES.length));
  const rate = CHORD_RATES[index] ?? CHORD_RATES[0];
  return { mode: "arp", ticks: rate.ticks, label: rate.id };
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
  const out: TimedEvent[] = [];
  harmony.forEach((harm) => {
    const hits = walkChord(harm, (tick) => {
      const step = tick / SIXTEENTH_TICKS;
      const rateU = evalModulated(withMacro(lane.rate, macro(macros, "rate")), step);
      const gateU = evalModulated(withMacro(lane.gate, macro(macros, "gate")), step);
      const toneU = evalModulated(withMacro(lane.tone, macro(macros, "tone")), step);
      const octaveU = evalModulated(withMacro(lane.octave, macro(macros, "octave")), step);
      const voices = chordVoices(harm, scale, rootPc, octaveU);
      const note = voices[chordToneIndex(toneU, voices.length)] ?? voices[0] ?? 0;
      return { ...chordFigure(rateU), gate: gateU, note, voices };
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

type FigureAt = ChordFigure & { gate: number; note: number; voices: readonly number[] };

/**
 * Rate, gate, tone, and octave are read once per note, so the figure follows
 * their envelopes at the resolution the pattern is drawn. A block is rechecked
 * each sixteenth and holds every chord tone at the octave it read when the
 * block began. Tone picks a single voice only while the figure is an arp.
 */
function walkChord(
  harm: HarmonicEvent,
  at: (tick: number) => FigureAt,
): { note: number; delay: number; lengthTicks: number }[] {
  const length = harm.lengthTicks;
  const hits: { note: number; delay: number; lengthTicks: number }[] = [];
  let cursor = 0;
  while (cursor < length) {
    const now = at(harm.startTick + cursor);
    if (now.mode === "block" || now.ticks <= 0) {
      const end = blockEnd(cursor, length, harm.startTick, at);
      const room = Math.max(1, end - cursor);
      for (const note of now.voices) hits.push({ note, delay: cursor, lengthTicks: room });
      cursor = end;
      continue;
    }
    const step = Math.max(1, now.ticks);
    const next = Math.min(length, cursor + step);
    const gateTicks = Math.max(1, Math.round(step * clampGate(now.gate)));
    const room = Math.max(1, Math.min(gateTicks, next - cursor, length - cursor));
    hits.push({ note: now.note, delay: cursor, lengthTicks: room });
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

function clampGate(gate: number): number {
  if (gate < 0.05) return 0.05;
  if (gate > 1) return 1;
  return gate;
}

export function hitsOn(phrase: Phrase, lane: LaneId): number[] {
  return [...new Set(phrase.lanes[lane].map((event) => event.step))].sort((a, b) => a - b);
}

export type { Hit };
