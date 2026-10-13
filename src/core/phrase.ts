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
import { generateHits, phraseStepsOf, type Hit } from "./events.ts";
import { applyFollow, chordToneDegrees, degreeToMidi, generateHarmony, harmonyAt, scaleOf } from "./harmony.ts";
import { bipolarFromUnit, evalModulated, withMacro } from "./modulate.ts";
import { mod } from "./motif.ts";
import {
  DRUM_NOTE,
  isDrum,
  isPitched,
  LANES,
  QUALITY_SEMITONES,
  type ChordPlay,
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

const BASS_OCTAVE = 2;
const LEAD_OCTAVE = 4;
const CHORD_OCTAVE = 4;

export function generatePhrase(project: Project): Phrase {
  const { global, working, macros, lock } = project;
  const bassSteps = laneSteps(working, "bass", global);
  const leadSteps = laneSteps(working, "lead", global);
  const chordSteps = sixteenthSteps(global.phrase, global.bar);
  const harmony = generateHarmony(working.chords, global, Math.max(bassSteps, leadSteps, chordSteps), lock.chords ? {} : macros);
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
  return chordAudio(lanes.chords.play, harmony, global, macros, lanes.chords.sound);
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
  const hits = generateHits(lane.gen1, lane.gen2, steps, global.seed, id, macro(macros, "velocity"));
  const out: TimedEvent[] = [];
  hits.forEach((hit) => {
    const count = countFromUnit(evalModulated(withMacro(lane.ratchet.count, macro(macros, "count")), hit.step));
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
  const hits = generateHits(lane.gen1, lane.gen2, steps, global.seed, id, macro(macros, "velocity"));
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  const octave = id === "bass" ? BASS_OCTAVE : LEAD_OCTAVE;
  const out: TimedEvent[] = [];
  hits.forEach((hit) => {
    const reps = countFromUnit(evalModulated(withMacro(lane.repeat, macro(macros, "repeat")), hit.step));
    const shift = Math.round(bipolarFromUnit(evalModulated(withMacro(lane.step, macro(macros, "step")), hit.step), 7));
    for (let r = 0; r < reps; r++) {
      const step = hit.step + r;
      const degreeU = evalModulated(withMacro(lane.degree, macro(macros, "degree")), step);
      const rangeU = evalModulated(withMacro(lane.range, macro(macros, "range")), step);
      const desired = (degreeU - 0.5) * 2 * rangeU * 7;
      const tick = swungStepTick(step, global.swing);
      const harm = harmonyAt(harmony, tick);
      const targets = harm ? chordToneDegrees(harm, scale, rootPc) : [];
      const followed = applyFollow(desired, lane.follow, targets);
      const note = degreeToMidi(Math.round(followed) + r * shift, scale, rootPc, octave);
      const lengthTicks = Math.max(1, Math.round(evalModulated(withMacro(lane.length, macro(macros, "length")), step) * global.bar * SIXTEENTH_TICKS));
      const sound = soundValues(lane.sound, step, macros);
      out.push(place(hit.step, r * SIXTEENTH_TICKS, global, id, note, hit.velocity, lengthTicks, sound));
    }
  });
  return out;
}

function chordAudio(
  play: ChordPlay,
  harmony: HarmonicEvent[],
  global: GlobalSettings,
  macros: Record<string, number>,
  sound: ChordLaneSound,
): TimedEvent[] {
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  const rate = RATES[Math.max(0, Math.min(RATES.length - 1, Math.round(play.rate)))] ?? RATES[1];
  const octaves = Math.max(1, Math.round(play.octaves));
  const out: TimedEvent[] = [];
  harmony.forEach((harm, index) => {
    const tones = voices(harm, scale, rootPc, play, octaves, index);
    const gateTicks = Math.max(1, Math.round(rate.ticks * clampGate(play.gate)));
    tones.forEach((note, voice) => {
      const arpTick = play.mode === 1 || play.mode === 3 ? voice * rate.ticks : 0;
      const strumTick = play.mode === 2 || play.mode === 3 ? Math.round(voice * play.strum * SIXTEENTH_TICKS) : 0;
      const start = harm.startTick + arpTick + strumTick;
      const rendered = soundValues(sound, start / SIXTEENTH_TICKS, macros);
      const sample = tickToSample(start, global.tempo);
      out.push({
        lane: "chords",
        tick: start,
        sample,
        sampleOffset: sampleOffset(sample),
        note,
        velocity: 0.85,
        lengthTicks: play.mode === 0 && play.strum === 0 ? harm.lengthTicks : gateTicks,
        step: Math.floor(harm.startTick / SIXTEENTH_TICKS),
        sound: rendered,
      });
    });
  });
  return out;
}

type ChordLaneSound = Parameters<typeof soundValues>[0];

function voices(harm: HarmonicEvent, scale: readonly number[], rootPc: number, play: ChordPlay, octaves: number, index: number): number[] {
  const rootPitch = pitchOf(harm.root, scale, rootPc);
  const semis = QUALITY_SEMITONES[harm.quality] ?? QUALITY_SEMITONES[0];
  let notes: number[] = [];
  for (let oct = 0; oct < octaves; oct++) {
    semis.forEach((semi, voice) => {
      const spread = voice % 2 === 1 ? Math.round(play.spread) : 0;
      notes.push(CHORD_OCTAVE * 12 + rootPitch + semi + (oct + spread) * 12);
    });
  }
  if (play.direction === 1) notes.reverse();
  if (play.direction === 2 && index % 2 === 1) notes.reverse();
  if (play.flow > 0 && notes.length > 1) {
    const pull = Math.round((play.flow - 0.5) * 2);
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
