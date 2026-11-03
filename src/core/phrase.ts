import {
  clamp01,
  countFromUnit,
  rateFromUnit,
  CHORD_RATES,
  sampleOffset,
  SIXTEENTH_TICKS,
  sixteenthSteps,
  swungStepTick,
  tickToSample,
} from "./clock.ts";
import { euclidPattern, generateHits, keptVelocity, phraseStepsOf, rotatePattern } from "./events.ts";
import { mixFieldValues } from "./fields.ts";
import { hash01 } from "./hash.ts";
import { applyFollowMidi, chordTonePitchClasses, degreeToMidi, generateHarmony, harmonyAt, pitchClassName, scaleOf } from "./harmony.ts";
import { latchStamp } from "./latch.ts";
import { bipolarFromUnit, evalModulated, hearVoices, soundMacro, voiceLane, withMacro } from "./modulate.ts";
import { laneHeard } from "./journal.ts";
import { macroOffset } from "./pages.ts";
import { envelopeTable, readEnvelope, type EnvelopeTable } from "../dsp/envelope.ts";
import {
  attachTables,
  cachedSound,
  hashPair,
  lookupBaked,
  lookupDrawn,
  lookupIdle,
  lookupMemo,
  mixNum,
  resetSoundHold,
  storeBaked,
  storeDrawn,
  storeIdle,
  storeMemo,
  voiceTable,
  type LaneBuilt,
} from "./phrase-cache.ts";
import { mod } from "./motif.ts";
import {
  fillSlice,
  octaveNumber,
  OCTAVE_MAX,
  OCTAVE_MIN,
  topLift,
  valueVoiceAt,
  valueVoices,
  voiceLeap,
  voiceTimeline,
  type ChordFigure,
  type VoiceFrame,
  type VoiceRead,
} from "./voice-lead.ts";

export { hashPair, voiceTable };
export { OCTAVE_MAX, OCTAVE_MIN, octaveNumber };
export type { ChordFigure };
import {
  DRUM_HZ,
  DRUM_NOTE,
  isDrum,
  isPitched,
  LANES,
  PROGRESSION_KEYS,
  type ChordLane,
  type DrumId,
  type DrumLane,
  type EuclidGen,
  type GlobalSettings,
  type HarmonicEvent,
  type LaneFilter,
  type LaneId,
  type LaneSend,
  type Lanes,
  type Phrase,
  type PitchedLane,
  type Progression,
  type Project,
  type TimedEvent,
} from "./types.ts";

function stampLanes(mix: (n: number) => void, lanes: Lanes): void {
  mixFieldValues(lanes, mix);
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
  for (const lane of LANES) {
    mix(project.mixer[lane]);
    mix(project.mute[lane] ? 1 : 0);
    mix(project.solo[lane] ? 1 : 0);
  }
  mix(project.mixer.master);
  for (const key of PROGRESSION_KEYS) mix(project.progression[key]);
  if (Math.round(project.progression.count) <= 0) text(latchStamp());
}

function idleStamp(project: Project): [number, number] {
  return hashPair((mix, text) => {
    stampLanes(mix, project.working);
    stampGlobal(mix, text, project);
  });
}

const BASS_OCTAVE = 3;
const LEAD_OCTAVE = 4;
/** Pitch value walks the selected scale ± two octaves. */
const SCALE_REACH = 14;
/** Degrees the whole run travels. The centre is no travel. */
const SPAN_REACH = 7;
export function homeOctave(lane: "bass" | "lead"): number {
  return lane === "bass" ? BASS_OCTAVE : LEAD_OCTAVE;
}

/** Unit 0 is octave 0, unit 1 is octave 9. */
export function unitForOctave(octave: number): number {
  const span = OCTAVE_MAX - OCTAVE_MIN;
  const n = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.round(octave)));
  return (n - OCTAVE_MIN) / span;
}

/** Scale degrees from the tonic. 0.5 is the tonic, the edges are two octaves of the scale away. */
export function scaleOffset(unit: number): number {
  return Math.round((clamp01(unit) - 0.5) * (SCALE_REACH * 2));
}

/** Scale degrees a generator-2 run travels. 0.5 is a flat run. */
export function spanDegrees(unit: number): number {
  return Math.round(bipolarFromUnit(unit, SPAN_REACH));
}

/** Resting scale note for the pitch knob, before pattern motion and follow. */
export function restingPitchLabel(pitch: number, octave: number, global: GlobalSettings): string {
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

/** 0 picks the root, 1 picks the top tone of this chord. */
export function chordToneIndex(unit: number, count: number): number {
  const n = Math.max(1, Math.round(count));
  if (n <= 1) return 0;
  return Math.round(clamp01(unit) * (n - 1));
}

/** Resting note of the chord tone knob: the led function at this step, value only. */
export function restingChordToneLabel(
  lane: ChordLane,
  progression: Progression,
  global: GlobalSettings,
  step = 0,
): string {
  const frame = valueVoiceAt(lane, progression, global, step);
  if (!frame?.notes.length) return "—";
  return noteLabel(frame.notes[chordToneIndex(lane.tone.value, frame.notes.length)] ?? frame.notes[0]);
}

/** Spread and flow captions for the value under the finger. Pattern and amount stay out. */
export function chordVoiceCaption(
  lane: ChordLane,
  progression: Progression,
  global: GlobalSettings,
  step = 0,
): { spread: string; flow: string } {
  const { frames, harmony } = valueVoices(lane, progression, global);
  const index = Math.max(0, Math.min(frames.length - 1, Math.floor(step)));
  const frame = frames[index];
  if (!frame?.notes.length) return { spread: "+0", flow: "0" };
  return { spread: `+${topLift(frame)}`, flow: harmony.length < 2 ? "0" : String(voiceLeap(harmony, frames, index)) };
}

function liveReader(lane: ChordLane, macros: Record<string, number>): VoiceRead {
  return {
    spread: (step) => clamp01(evalModulated(withMacro(lane.spread, macro(macros, "spread")), step)),
    flow: (step) => clamp01(evalModulated(withMacro(lane.flow, macro(macros, "flow")), step)),
    octave: (step) => evalModulated(withMacro(lane.octave, macro(macros, "octave")), step),
  };
}

function mixMusical(mix: (n: number) => void, text: (s: string) => void, global: Project["global"]): void {
  mix(global.tempo);
  mix(global.swing);
  mix(global.root);
  text(global.scale);
  mix(global.transpose);
  mix(global.bar);
  mix(global.phrase);
  mix(global.seed);
}

/** What this lane's notes depend on. A kick commit does not move the bass stamp. */
function laneKey(project: Project, lane: LaneId, sources: ReadonlySet<LaneId>): [number, number] {
  const { global, working } = project;
  return hashPair((mix, text) => {
    mixMusical(mix, text, global);
    mixFieldValues(working, mix, lane);
    mix(project.lock[lane] ? 1 : 0);
    if (!project.lock[lane]) {
      for (const id of Object.keys(project.macros).sort()) {
        text(id);
        mix(project.macros[id] ?? 0);
      }
    }
    if (lane === "bass" || lane === "lead" || lane === "chords") {
      for (const key of PROGRESSION_KEYS) mix(project.progression[key]);
      mix(laneSteps(working, "bass", global));
      mix(laneSteps(working, "lead", global));
      mix(laneSteps(working, "chords", global));
      if (Math.round(project.progression.count) <= 0) text(latchStamp());
    }
    if (laneUsesVoice(working, lane)) {
      for (const source of sources) {
        mixFieldValues(working, mix, source);
        mix(project.mixer[source]);
        mix(project.mute[source] ? 1 : 0);
        mix(project.solo[source] ? 1 : 0);
      }
      mix(project.mixer.master);
    }
  });
}

export function generatePhrase(project: Project): Phrase {
  const key = idleStamp(project);
  const cached = lookupIdle(key);
  if (cached) return cached;
  return storeIdle(key, phraseOf(project, project.working));
}

function phraseOf(project: Project, working: Lanes): Phrase {
  resetSoundHold();
  const { global, macros, lock } = project;
  const bassSteps = laneSteps(working, "bass", global);
  const leadSteps = laneSteps(working, "lead", global);
  const chordSteps = sixteenthSteps(global.phrase, global.bar);
  const harmKey = hashPair((mix, text) => {
    mixMusical(mix, text, global);
    for (const key of PROGRESSION_KEYS) mix(project.progression[key]);
    mix(bassSteps);
    mix(leadSteps);
    mix(chordSteps);
    if (Math.round(project.progression.count) <= 0) text(latchStamp());
  });
  const phraseMemo = lookupMemo();
  const harmony = phraseMemo && phraseMemo.harmonyA === harmKey[0] && phraseMemo.harmonyB === harmKey[1]
    ? phraseMemo.harmony
    : generateHarmony(project.progression, global, Math.max(bassSteps, leadSteps, chordSteps));
  const sources = voiceSources(working);
  const built = {} as Record<LaneId, LaneBuilt>;
  const fresh: LaneId[] = [];
  let same = phraseMemo !== null && phraseMemo.harmony === harmony;
  for (const lane of LANES) {
    const key = laneKey(project, lane, sources);
    const prev = phraseMemo?.lanes[lane];
    if (prev && prev.a === key[0] && prev.b === key[1]) {
      built[lane] = prev;
      continue;
    }
    same = false;
    fresh.push(lane);
    const steps = laneSteps(working, lane, global);
    const dry = eventsFor(working, lane, global, lock[lane] ? {} : macros, harmony, steps);
    built[lane] = { a: key[0], b: key[1], steps, dry, events: dry };
  }
  if (same && phraseMemo) return phraseMemo.phrase;
  const steps = {} as Phrase["steps"];
  const lanes = {} as Phrase["lanes"];
  for (const lane of LANES) {
    steps[lane] = built[lane].steps;
    lanes[lane] = built[lane].dry;
  }
  const voiced = fresh.filter((lane) => laneUsesVoice(working, lane));
  let tables: ReturnType<typeof dryTables> | null = null;
  if (sources.size > 0 && voiced.length > 0) {
    const tempo = Math.max(1, project.global.tempo);
    const baked = dryTables(project, { lanes, harmony, steps }, sources, tempo);
    tables = baked;
    const sixteenth = tickToSample(SIXTEENTH_TICKS, tempo);
    hearVoices((pattern, step) => voiceEnvAt(baked, pattern, step * sixteenth), () => {
      for (const lane of voiced) {
        built[lane].events = eventsFor(working, lane, global, lock[lane] ? {} : macros, harmony, steps[lane]);
      }
    });
  }
  for (const lane of LANES) lanes[lane] = built[lane].events;
  const phrase = { lanes, harmony, steps };
  if (tables) attachTables(phrase, tables);
  storeMemo({ harmonyA: harmKey[0], harmonyB: harmKey[1], harmony, lanes: built, phrase });
  return phrase;
}

function voiceEnvAt(tables: ReadonlyMap<LaneId, EnvelopeTable>, pattern: number, sample: number): number {
  const lane = voiceLane(pattern);
  const table = lane ? tables.get(lane) : undefined;
  return table ? readEnvelope(table, sample) : 0;
}

/** The curve reads the same table the phrase used at each step. */
export function laneEnvelope(project: Project, phrase: Phrase, lane: LaneId): EnvelopeTable {
  const drawn = lookupDrawn(phrase, lane);
  if (drawn) return drawn;
  const attached = voiceTable(phrase, lane);
  if (attached) return storeDrawn(phrase, lane, attached);
  const tempo = Math.max(1, project.global.tempo);
  const table = envelopeTable(shapeHits(project, phrase, new Set([lane]), tempo), lane, tempo);
  return storeDrawn(phrase, lane, table);
}

function dryTables(project: Project, phrase: Phrase, sources: ReadonlySet<LaneId>, tempo: number): Map<LaneId, EnvelopeTable> {
  const stamp = materialStamp(project, phrase, sources, tempo);
  const baked = lookupBaked(stamp);
  if (baked) return baked;
  const hits = shapeHits(project, phrase, sources, tempo);
  const tables = new Map<LaneId, EnvelopeTable>();
  for (const lane of LANES) {
    if (!sources.has(lane)) continue;
    tables.set(lane, envelopeTable(hits, lane, tempo));
  }
  return storeBaked(stamp, tables);
}

function voiced(knob: { pattern: number; amount: number } | undefined): knob is { pattern: number; amount: number } {
  return !!knob && knob.pattern < 0 && knob.amount !== 0;
}

function voiceSources(working: Lanes): Set<LaneId> {
  const need = new Set<LaneId>();
  const take = (knob: { pattern: number; amount: number } | undefined) => {
    if (!voiced(knob)) return;
    const lane = voiceLane(knob.pattern);
    if (lane) need.add(lane);
  };
  for (const id of LANES) takeLane(working, id, take);
  return need;
}

/** This lane reads a voice, so its notes are built again once the dry envelopes exist. */
function laneUsesVoice(working: Lanes, id: LaneId): boolean {
  let hit = false;
  takeLane(working, id, (knob) => {
    if (voiced(knob)) hit = true;
  });
  return hit;
}

function takeLane(
  working: Lanes,
  id: LaneId,
  take: (knob: { pattern: number; amount: number } | undefined) => void,
): void {
  const lane = working[id];
  for (const knob of Object.values(lane.sound)) take(knob);
  take(lane.filter.cutoff);
  take(lane.filter.resonance);
  take(lane.send.reverb);
  take(lane.send.delay);
  if (isDrum(id)) {
    const box = lane as DrumLane;
    take(box.ratchet.count);
    take(box.ratchet.rate);
    take(box.ratchet.fade);
    take(box.ratchet.tone);
    take(box.gen1.velocity);
    take(box.gen2.velocity);
  }
  if (isPitched(id)) {
    const box = lane as PitchedLane;
    take(box.gen1.velocity);
    take(box.gen2.velocity);
    take(box.pitch);
    take(box.octave);
    take(box.length);
    take(box.repeat);
    take(box.step);
  }
  if (id === "chords") {
    const box = lane as ChordLane;
    take(box.gen1.velocity);
    take(box.tone);
    take(box.octave);
    take(box.spread);
    take(box.flow);
    take(box.rate);
    take(box.gate);
    take(box.size);
    take(box.velocity);
    take(box.probability);
  }
}

const SHAPE_KEYS = ["decay", "bodyDecay", "noiseDecay", "snap", "ring", "attack", "release"] as const;
const SHAPE_IDS = ["decay", "bdcy", "ndcy", "snap", "ring", "attack", "release"] as const;

function materialStamp(project: Project, phrase: Phrase, sources: ReadonlySet<LaneId>, tempo: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ Math.round(tempo * 1000), 16777619) >>> 0;
  for (const lane of LANES) {
    if (!sources.has(lane)) continue;
    h = Math.imul(h ^ (LANES.indexOf(lane) + 1), 16777619) >>> 0;
    h = Math.imul(h ^ (laneHeard(project, lane) ? 1 : 0), 16777619) >>> 0;
    h = Math.imul(h ^ phrase.steps[lane], 16777619) >>> 0;
    h = mixNum(h, project.mixer[lane] * project.mixer.master, 16777619);
    if (!laneHeard(project, lane)) continue;
    const events = phrase.lanes[lane];
    h = Math.imul(h ^ events.length, 16777619) >>> 0;
    for (const event of events) {
      h = Math.imul(h ^ event.sample, 16777619) >>> 0;
      h = Math.imul(h ^ event.lengthTicks, 16777619) >>> 0;
      h = mixNum(h, event.velocity, 16777619);
      for (const key of SHAPE_KEYS) {
        const value = event.sound[key];
        if (value === undefined) continue;
        h = mixNum(h, value, 16777619);
      }
    }
  }
  return h;
}

function shapeHits(project: Project, phrase: Phrase, sources: ReadonlySet<LaneId>, tempo: number) {
  const out: {
    sample: number;
    loop: number;
    lane: LaneId;
    velocity: number;
    lengthTicks: number;
    params: { id: string; value: number }[];
  }[] = [];
  for (const lane of LANES) {
    if (!sources.has(lane) || !laneHeard(project, lane)) continue;
    const steps = Math.max(1, phrase.steps[lane]);
    const loop = Math.max(1, tickToSample(steps * SIXTEENTH_TICKS, tempo));
    const gain = project.mixer[lane] * project.mixer.master;
    for (const event of phrase.lanes[lane]) {
      out.push({
        sample: ((event.sample % loop) + loop) % loop,
        loop,
        lane,
        velocity: Math.max(1, Math.min(127, Math.round(event.velocity * gain * 127))),
        lengthTicks: event.lengthTicks,
        params: shapeParams(event.sound),
      });
    }
  }
  return out;
}

function shapeParams(sound: Record<string, number>): { id: string; value: number }[] {
  const params: { id: string; value: number }[] = [];
  for (let i = 0; i < SHAPE_KEYS.length; i++) {
    const value = sound[SHAPE_KEYS[i] ?? ""];
    if (value === undefined) continue;
    params.push({ id: SHAPE_IDS[i] ?? "", value });
  }
  return params;
}

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
  return chordAudio(lanes.chords, harmony, global, macros, lanes.chords.sound, lanes.chords.filter, lanes.chords.send, steps);
}

function macro(macros: Record<string, number>, id: string): number {
  return macroOffset(id, macros);
}

type SoundKnobs = Record<string, { value: number; pattern: number; cycle: number; amount: number }>;

function evalSound(sound: SoundKnobs, keys: readonly string[], step: number, macros: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of keys) out[id] = evalModulated(withMacro(sound[id], soundMacro(id, macros)), step);
  return out;
}

/** One key list per sound object. A lane with no live amount shares a single record across its notes. */
function bindSound(sound: SoundKnobs, macros: Record<string, number>): (step: number) => Record<string, number> {
  const keys = Object.keys(sound);
  let varies = false;
  for (const id of keys) {
    if ((sound[id]?.amount ?? 0) !== 0) varies = true;
  }
  if (!varies) {
    const value = evalSound(sound, keys, 0, macros);
    return () => value;
  }
  return (step) => evalSound(sound, keys, step, macros);
}

function soundValues(sound: SoundKnobs, step: number, macros: Record<string, number>): Record<string, number> {
  return cachedSound(sound, macros, () => bindSound(sound, macros))(step);
}

function filterValues(filter: LaneFilter, step: number, macros: Record<string, number>): TimedEvent["filter"] {
  return {
    cutoff: evalModulated(withMacro(filter.cutoff, macro(macros, "cutoff")), step),
    resonance: evalModulated(withMacro(filter.resonance, macro(macros, "resonance")), step),
  };
}

function sendValues(send: LaneSend, step: number, macros: Record<string, number>): TimedEvent["send"] {
  return {
    reverb: evalModulated(withMacro(send.reverb, macro(macros, "reverb")), step),
    delay: evalModulated(withMacro(send.delay, macro(macros, "delay")), step),
  };
}

function place(
  step: number,
  extraTicks: number,
  global: GlobalSettings,
  lane: LaneId,
  note: number,
  velocity: number,
  lengthTicks: number,
  sound: Record<string, number>,
  filter: TimedEvent["filter"],
  send: TimedEvent["send"],
): TimedEvent {
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
    filter,
    send,
  };
}

/** A tick this quiet is left out, so it does not retrigger the drum voice. */
const ROLL_QUIET = 0.125;

/** How far snare tone and hat color follow a pitch shift of one octave. */
const ROLL_BRIGHT = 0.5;

function rollLevel(fade: number, t: number): number {
  const tilt = (fade - 0.5) * 2;
  if (tilt >= 0) return 1 - tilt * (1 - t);
  return 1 + tilt * t;
}

/** 0 on the grid hit. Positive means the tick is higher as time moves forward. */
function rollOctaves(tone: number, t: number, rise: boolean): number {
  const along = rise ? t - 1 : t;
  return (tone - 0.5) * 2 * along;
}

function shiftPitch(id: DrumId, unit: number, octaves: number): number {
  const [lo, hi] = DRUM_HZ[id];
  const span = Math.log(hi / lo);
  return clamp01(unit + (octaves * Math.LN2) / span);
}

function pictureNote(id: DrumId, unit: number, shifted: number): number {
  const base = DRUM_NOTE[id];
  if (Math.abs(shifted - unit) < 1e-6) return base;
  const [lo, hi] = DRUM_HZ[id];
  const hz = (u: number) => lo * (hi / lo) ** u;
  const semis = Math.round(12 * Math.log2(hz(shifted) / hz(unit)));
  return Math.max(0, Math.min(127, base + semis));
}

/** Pitch, decay and a little brightness. Returns the note the phrase strip draws. */
function shapeRoll(id: DrumId, sound: Record<string, number>, octaves: number, level: number): number {
  const pitch = sound.pitch ?? 0.5;
  const shifted = shiftPitch(id, pitch, octaves);
  sound.pitch = shifted;
  if (id === "snare") {
    if (typeof sound.bodyDecay === "number") sound.bodyDecay = clamp01(sound.bodyDecay * level);
    if (typeof sound.noiseDecay === "number") sound.noiseDecay = clamp01(sound.noiseDecay * level);
    if (typeof sound.tone === "number") sound.tone = clamp01(sound.tone + octaves * ROLL_BRIGHT);
  } else if (typeof sound.decay === "number") {
    sound.decay = clamp01(sound.decay * level);
  }
  if (id === "hat" && typeof sound.color === "number") sound.color = clamp01(sound.color + octaves * ROLL_BRIGHT);
  return pictureNote(id, pitch, shifted);
}

function drumEvents(lane: DrumLane, id: DrumId, global: GlobalSettings, macros: Record<string, number>, steps: number): TimedEvent[] {
  const hits = generateHits(lane.gen1, lane.gen2, steps);
  const out: TimedEvent[] = [];
  for (const hit of hits) {
    const rolls = hit.generators.includes(2);
    const count = rolls ? countFromUnit(evalModulated(withMacro(lane.ratchet.count, macro(macros, "count")), hit.step)) : 1;
    const rate = rolls ? rateFromUnit(evalModulated(withMacro(lane.ratchet.rate, macro(macros, "rate")), hit.step)) : null;
    const shaped = rolls && count > 1;
    const fade = shaped ? evalModulated(lane.ratchet.fade, hit.step) : 0.5;
    const tone = shaped ? evalModulated(lane.ratchet.tone, hit.step) : 0.5;
    const rise = fade > 0.5;
    const ticks = rate?.ticks ?? SIXTEENTH_TICKS;
    for (let i = 0; i < count; i++) {
      const t = count <= 1 ? 0 : i / (count - 1);
      const level = shaped ? rollLevel(fade, t) : 1;
      if (level < ROLL_QUIET) continue;
      const extra = shaped && rise ? (i - (count - 1)) * ticks : i * ticks;
      const at = hit.step + extra / SIXTEENTH_TICKS;
      const velocity = keptVelocity(lane.gen1, lane.gen2, hit.generators, global.seed, id, hit.step, i, macro(macros, "velocity"), macro(macros, "probability"), at);
      if (velocity === null) continue;
      const heard = soundValues(lane.sound, at, macros);
      const sound = shaped ? { ...heard } : heard;
      const note = shaped ? shapeRoll(id, sound, rollOctaves(tone, t, rise), level) : DRUM_NOTE[id];
      const filter = filterValues(lane.filter, at, macros);
      const send = sendValues(lane.send, at, macros);
      out.push(place(hit.step, extra, global, id, note, velocity * level, ticks, sound, filter, send));
    }
  }
  return out;
}

function noteTicks(length: PitchedLane["length"], step: number, macros: Record<string, number>, bar: number): number {
  const unit = evalModulated(withMacro(length, macro(macros, "length")), step);
  return Math.max(1, Math.round(unit * bar * SIXTEENTH_TICKS));
}

function pitchedEvents(
  lane: PitchedLane,
  id: "bass" | "lead",
  global: GlobalSettings,
  macros: Record<string, number>,
  harmony: HarmonicEvent[],
  steps: number,
): TimedEvent[] {
  const hits = generateHits(lane.gen1, lane.gen2, steps);
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  const out: TimedEvent[] = [];
  for (const hit of hits) {
    const runs = hit.generators.includes(2);
    const count = runs ? countFromUnit(evalModulated(withMacro(lane.repeat, macro(macros, "repeat")), hit.step)) : 1;
    const shaped = runs && count > 1;
    const span = shaped ? spanDegrees(evalModulated(withMacro(lane.step, macro(macros, "step")), hit.step)) : 0;
    const whole = noteTicks(lane.length, hit.step, macros, global.bar);
    for (let r = 0; r < count; r++) {
      const extra = shaped ? Math.round((r * whole) / count) : 0;
      const at = hit.step + extra / SIXTEENTH_TICKS;
      const tick = swungStepTick(hit.step, global.swing) + extra;
      const heard = noteTicks(lane.length, at, macros, global.bar);
      const lengthTicks = shaped ? Math.max(1, Math.round(heard / count)) : heard;
      const velocity = keptVelocity(lane.gen1, lane.gen2, hit.generators, global.seed, id, hit.step, r, macro(macros, "velocity"), macro(macros, "probability"), at);
      if (velocity === null) continue;
      const pitchU = evalModulated(withMacro(lane.pitch, macro(macros, "pitch")), at);
      const octaveU = evalModulated(withMacro(lane.octave, macro(macros, "octave")), at);
      const along = shaped ? r / (count - 1) : 0;
      const degree = scaleOffset(pitchU) + Math.round(span * along);
      const desiredMidi = degreeToMidi(degree, scale, rootPc, octaveNumber(octaveU));
      const harm = harmonyAt(harmony, tick);
      const chordPcs = harm ? chordTonePitchClasses(harm, scale, rootPc) : [];
      const note = Math.max(0, Math.min(127, Math.round(applyFollowMidi(desiredMidi, lane.follow, chordPcs))));
      const sound = soundValues(lane.sound, at, macros);
      const filter = filterValues(lane.filter, at, macros);
      const send = sendValues(lane.send, at, macros);
      out.push(place(hit.step, extra, global, id, note, velocity, lengthTicks, sound, filter, send));
    }
  }
  return out;
}

/** Sixteenths that sound inside a hole. 0 is one step, 1 is the whole hole. */
export function sliceLength(gapSteps: number, sizeUnit: number): number {
  const gap = Math.max(1, Math.round(gapSteps));
  const unit = clamp01(sizeUnit);
  return Math.max(1, Math.min(gap, Math.round(1 + unit * (gap - 1))));
}

/** Hole of the first step, from the size value alone. Header while that knob is held. */
export function restingSliceLabel(lane: ChordLane, global: GlobalSettings): string {
  const steps = sixteenthSteps(global.phrase, global.bar);
  const { ring, onsets } = ringOnsets(lane.gen1);
  if (!onsets.length) return "—";
  let first = -1;
  for (let base = 0; base < steps && first < 0; base += ring) {
    for (const onset of onsets) {
      if (base + onset < steps) {
        first = base + onset;
        break;
      }
    }
  }
  if (first < 0) return "—";
  const gap = Math.max(1, nextOnset(first, onsets, ring) - first);
  return `${sliceLength(gap, lane.size.value)}/${gap}`;
}

const SILENT_GEN: EuclidGen = {
  length: 0,
  hits: 0,
  rotate: 0,
  probability: 0,
  velocity: { value: 0, pattern: 0, cycle: 1, amount: 0 },
};

function ringOnsets(gen: EuclidGen): { ring: number; onsets: number[] } {
  const ring = Math.max(0, Math.round(gen.length));
  const count = ring > 0 ? Math.max(0, Math.min(ring, Math.round(gen.hits))) : 0;
  if (!ring || !count) return { ring: Math.max(1, ring), onsets: [] };
  const pattern = rotatePattern(euclidPattern(count, ring), gen.rotate);
  const onsets: number[] = [];
  for (let step = 0; step < pattern.length; step++) if (pattern[step]) onsets.push(step);
  return { ring, onsets };
}

/** Next placed step on the ring, even when that step falls past the phrase. */
function nextOnset(step: number, onsets: readonly number[], ring: number): number {
  const phase = ((step % ring) + ring) % ring;
  for (const onset of onsets) {
    if (onset > phase) return step - phase + onset;
  }
  return step - phase + ring + (onsets[0] ?? 0);
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
  filter: LaneFilter,
  send: LaneSend,
  steps: number,
): TimedEvent[] {
  const scale = scaleOf(global.scale);
  const rootPc = mod(global.root + global.transpose, 12);
  const voiced = voiceTimeline(harmony, steps, scale, rootPc, liveReader(lane, macros));
  const phraseTicks = steps * SIXTEENTH_TICKS;
  const placed = generateHits(lane.gen1, SILENT_GEN, steps);
  const { ring, onsets } = ringOnsets(lane.gen1);
  const out: TimedEvent[] = [];
  for (const hit of placed) {
    const kept = keptVelocity(
      lane.gen1,
      SILENT_GEN,
      hit.generators,
      global.seed,
      "chords",
      hit.step,
      0,
      macro(macros, "velocity"),
      macro(macros, "probability"),
    );
    if (kept === null || !onsets.length) continue;
    const gap = Math.max(1, nextOnset(hit.step, onsets, ring) - hit.step);
    const sizeU = evalModulated(withMacro(lane.size, macro(macros, "size")), hit.step);
    const start = swungStepTick(hit.step, global.swing);
    const end = start + sliceLength(gap, sizeU) * SIXTEENTH_TICKS;
    const blockKept = rollChance(chanceAt(lane, macros, hit.step), global.seed, "block", hit.step);
    placeSlice(out, lane, harmony, global, macros, sound, filter, send, voiced, start, end, phraseTicks, blockKept);
  }
  return out;
}

/** A slice is the part of the hole that sounds. Rate fills it; the rest of the hole stays quiet. */
function placeSlice(
  out: TimedEvent[],
  lane: ChordLane,
  harmony: HarmonicEvent[],
  global: GlobalSettings,
  macros: Record<string, number>,
  sound: ChordLaneSound,
  filter: LaneFilter,
  send: LaneSend,
  voiced: readonly VoiceFrame[],
  start: number,
  end: number,
  phraseTicks: number,
  blockKept: boolean,
): void {
  const rateAt = rateAlong(lane, macros);
  const hits = fillSlice(harmony, start, end, phraseTicks, blockKept, (tick) => {
    const step = tick / SIXTEENTH_TICKS;
    const gateU = evalModulated(withMacro(lane.gate, macro(macros, "gate")), step);
    const toneU = evalModulated(withMacro(lane.tone, macro(macros, "tone")), step);
    const frame = voiced[Math.max(0, Math.min(voiced.length - 1, Math.floor(step)))] ?? { notes: [], open: [] };
    const count = Math.max(1, frame.notes.length);
    return {
      ...rateAt(tick),
      gate: gateU,
      note: frame.notes[chordToneIndex(toneU, count)] ?? frame.notes[0] ?? 0,
      voices: frame.notes,
    };
  }, rateAt, (tick, note) => rollChance(chanceAt(lane, macros, tick / SIXTEENTH_TICKS), global.seed, "note", tick, note));
  for (const { note, tick, lengthTicks } of hits) {
    const rendered = soundValues(sound, tick / SIXTEENTH_TICKS, macros);
    const heard = filterValues(filter, tick / SIXTEENTH_TICKS, macros);
    const sent = sendValues(send, tick / SIXTEENTH_TICKS, macros);
    const sample = tickToSample(tick, global.tempo);
    out.push({
      lane: "chords",
      tick,
      sample,
      sampleOffset: sampleOffset(sample),
      note,
      velocity: evalModulated(withMacro(lane.velocity, macro(macros, "velocity")), tick / SIXTEENTH_TICKS),
      lengthTicks,
      step: Math.floor(tick / SIXTEENTH_TICKS),
      sound: rendered,
      filter: heard,
      send: sent,
    });
  }
}

function chanceAt(lane: ChordLane, macros: Record<string, number>, step: number): number {
  return clamp01(evalModulated(withMacro(lane.probability, macro(macros, "probability")), step));
}

/** 1 keeps the note. 0 drops it. Anything between rolls once for this salt. */
function rollChance(probability: number, seed: number, ...salt: (string | number)[]): boolean {
  if (probability >= 1) return true;
  if (probability <= 0) return false;
  return hash01(seed, "chords", ...salt) < probability;
}

/** One rate figure per tick. A block scans sixteenths and only needs this, not gate or voices. */
function rateAlong(lane: ChordLane, macros: Record<string, number>): (tick: number) => ChordFigure {
  const cache = new Map<number, ChordFigure>();
  return (tick) => {
    const hit = cache.get(tick);
    if (hit) return hit;
    const step = tick / SIXTEENTH_TICKS;
    const rateU = evalModulated(withMacro(lane.rate, macro(macros, "rate")), step);
    const figure = chordFigure(rateU);
    cache.set(tick, figure);
    return figure;
  };
}

type ChordLaneSound = Parameters<typeof soundValues>[0];
