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
import { applyFollowMidi, chordTonePitchClasses, degreeToMidi, generateHarmony, harmonyAt, pitchClassName, pitchClassOfDegree, scaleOf } from "./harmony.ts";
import { latchStamp, matchQuality } from "./latch.ts";
import { bipolarFromUnit, evalModulated, hearVoices, soundMacro, voiceLane, withMacro } from "./modulate.ts";
import { laneHeard } from "./journal.ts";
import { macroOffset } from "./pages.ts";
import { envelopeTable, readEnvelope, type EnvelopeTable } from "../dsp/envelope.ts";
import { mod } from "./motif.ts";
import {
  DRUM_NOTE,
  isDrum,
  isPitched,
  LANES,
  PROGRESSION_KEYS,
  QUALITY_SEMITONES,
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
  return stampPair((mix, text) => {
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

/** Scale degrees from the tonic. 0.5 is the tonic, the edges are two octaves of the scale away. */
export function scaleOffset(unit: number): number {
  return Math.round((clamp01(unit) - 0.5) * (SCALE_REACH * 2));
}

/** Scale degrees a generator-2 run travels. 0.5 is a flat run. */
export function spanDegrees(unit: number): number {
  return Math.round(bipolarFromUnit(unit, SPAN_REACH));
}

/** Absolute octave of the tonic, 0..9. */
export function octaveNumber(unit: number): number {
  return OCTAVE_MIN + Math.round(clamp01(unit) * (OCTAVE_MAX - OCTAVE_MIN));
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
  const steps = sixteenthSteps(global.phrase, global.bar);
  const harmony = generateHarmony(progression, global, steps);
  const frames = voiceTimeline(harmony, steps, scaleOf(global.scale), mod(global.root + global.transpose, 12), valueReader(lane));
  const index = Math.max(0, Math.min(frames.length - 1, Math.floor(step)));
  const frame = frames[index];
  if (!frame?.notes.length) return { spread: "+0", flow: "0" };
  return { spread: `+${topLift(frame)}`, flow: harmony.length < 2 ? "0" : String(voiceLeap(harmony, frames, index)) };
}

interface ChordFns {
  rootPc: number;
  semis: readonly number[];
  pcs: readonly number[];
}

interface VoiceFrame {
  /** Function order, after the octave shift and spread. */
  notes: number[];
  /** The same voices before spread. */
  open: number[];
}

interface VoiceCarry {
  notes: number[];
  rootPc: number;
}

interface VoiceRead {
  spread: (step: number) => number;
  flow: (step: number) => number;
  octave: (step: number) => number;
}

function valueReader(lane: ChordLane): VoiceRead {
  return {
    spread: () => clamp01(lane.spread.value),
    flow: () => clamp01(lane.flow.value),
    octave: () => lane.octave.value,
  };
}

function valueVoiceAt(lane: ChordLane, progression: Progression, global: GlobalSettings, step: number): VoiceFrame | null {
  const steps = sixteenthSteps(global.phrase, global.bar);
  const frames = voiceTimeline(
    generateHarmony(progression, global, steps),
    steps,
    scaleOf(global.scale),
    mod(global.root + global.transpose, 12),
    valueReader(lane),
  );
  if (!frames.length) return null;
  return frames[Math.max(0, Math.min(frames.length - 1, Math.floor(step)))] ?? null;
}

function chordFns(harm: HarmonicEvent, scale: readonly number[], keyRoot: number): ChordFns {
  if (harm.pcs && harm.pcs.length > 0) {
    const matched = matchQuality(harm.pcs, harm.pcs[0]);
    const rootPc = matched?.rootPc ?? mod(harm.pcs[0], 12);
    const semis = [...new Set(harm.pcs.map((pc) => mod(pc - rootPc, 12)))].sort((a, b) => a - b);
    if (!semis.includes(0)) semis.unshift(0);
    return { rootPc, semis, pcs: semis.map((semi) => mod(rootPc + semi, 12)) };
  }
  const rootPc = pitchClassOfDegree(harm.root, scale, keyRoot);
  const semis = [...(QUALITY_SEMITONES[harm.quality] ?? QUALITY_SEMITONES[0])];
  return { rootPc, semis, pcs: semis.map((semi) => mod(rootPc + semi, 12)) };
}

function closeVoicing(fns: ChordFns, octaveUnit: number): number[] {
  const rootMidi = octaveNumber(octaveUnit) * 12 + fns.rootPc;
  return separate(fns.semis.map((semi) => clampMidi(rootMidi + semi)));
}

function clampMidi(note: number): number {
  return Math.max(0, Math.min(127, Math.round(note)));
}

/** Shortest root motion, −6..+6. A tritone stays upward. */
function signedPc(from: number, to: number): number {
  let delta = mod(to - from, 12);
  if (delta > 6) delta -= 12;
  return delta;
}

function nearestOctave(target: number, pc: number): { midi: number; dist: number } {
  const center = Math.round(target);
  const origin = Math.floor(center / 12) * 12;
  let midi = clampMidi(origin + pc);
  let dist = Math.abs(midi - target);
  for (let oct = -2; oct <= 2; oct++) {
    const note = clampMidi(origin + oct * 12 + pc);
    const gap = Math.abs(note - target);
    if (gap < dist - 1e-6 || (Math.abs(gap - dist) <= 1e-6 && note < midi)) {
      midi = note;
      dist = gap;
    }
  }
  return { midi, dist };
}

function sameNotes(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function separate(notes: readonly number[]): number[] {
  const out = notes.map((note) => clampMidi(note));
  const order = out.map((midi, index) => ({ midi, index })).sort((a, b) => a.midi - b.midi || a.index - b.index);
  const used = new Set<number>();
  for (const slot of order) {
    let midi = out[slot.index];
    while (used.has(midi) && midi < 127) midi += 12;
    out[slot.index] = clampMidi(midi);
    used.add(out[slot.index]);
  }
  return out;
}

/**
 * Give every function a pitch. Sources are attractors; a function left without
 * one sits in close position above the root and does not add to the cost.
 */
function cover(sources: readonly number[], fns: ChordFns, preferLeap: boolean, from: readonly number[]): number[] {
  const pcs = fns.pcs;
  const m = pcs.length;
  const n = sources.length;
  if (m === 0) return [];
  if (n === 0) return [];
  const midis = new Array<number>(m).fill(0);
  const used = new Array<boolean>(n).fill(false);
  let bestKey = Number.POSITIVE_INFINITY;
  let bestLeap = Number.POSITIVE_INFINITY;
  let bestLow = Number.POSITIVE_INFINITY;
  let best = midis.slice();

  const finish = (cost: number, leap: number, low: number) => {
    const better = cost < bestKey - 1e-6
      || (Math.abs(cost - bestKey) <= 1e-6 && (preferLeap ? leap < bestLeap - 1e-6 : low < bestLow))
      || (Math.abs(cost - bestKey) <= 1e-6 && preferLeap && Math.abs(leap - bestLeap) <= 1e-6 && low < bestLow);
    if (!better) return;
    bestKey = cost;
    bestLeap = leap;
    bestLow = low;
    best = midis.slice();
  };

  const placeRest = (fi: number, rootMidi: number, cost: number, leap: number, low: number) => {
    for (let i = fi; i < m; i++) {
      const semi = mod(pcs[i] - fns.rootPc, 12);
      midis[i] = clampMidi(rootMidi + semi);
      low += midis[i];
    }
    finish(cost, leap, low);
  };

  const walk = (fi: number, cost: number, leap: number, low: number) => {
    if (cost > bestKey + 1e-6) return;
    if (fi === m) {
      finish(cost, leap, low);
      return;
    }
    let open = false;
    for (let s = 0; s < n; s++) {
      if (used[s]) continue;
      open = true;
      used[s] = true;
      const hit = nearestOctave(sources[s], pcs[fi]);
      const origin = from[s] ?? sources[s];
      midis[fi] = hit.midi;
      walk(fi + 1, cost + hit.dist, leap + Math.abs(hit.midi - origin), low + hit.midi);
      used[s] = false;
    }
    if (!open) placeRest(fi, midis[0] ?? octaveNumber(0) * 12 + fns.rootPc, cost, leap, low);
  };

  walk(0, 0, 0, 0);
  return separate(best);
}

function parallelVoicing(prev: VoiceCarry, fns: ChordFns): number[] {
  const delta = signedPc(prev.rootPc, fns.rootPc);
  return cover(prev.notes.map((note) => note + delta), fns, false, []);
}

function nearestVoicing(prev: VoiceCarry, fns: ChordFns): number[] {
  return cover(prev.notes, fns, false, []);
}

/** Height order, then back into functions. A tie keeps the smaller leap from the previous pitch. */
function blendVoices(parallel: readonly number[], nearest: readonly number[], flow: number, prev: readonly number[], fns: ChordFns): number[] {
  const plane = [...parallel].sort((a, b) => a - b);
  const still = [...nearest].sort((a, b) => a - b);
  const was = [...prev].sort((a, b) => a - b);
  const targets = plane.map((note, i) => (1 - flow) * note + flow * (still[i] ?? note));
  const from = targets.map((note, i) => was[i] ?? note);
  return cover(targets, fns, true, from);
}

function applySpread(open: readonly number[], spread: number): number[] {
  if (open.length <= 1 || spread <= 0) return [...open];
  const order = open.map((midi, index) => ({ midi, index })).sort((a, b) => a.midi - b.midi || a.index - b.index);
  const out = [...open];
  const span = order.length - 1;
  for (let i = 1; i < order.length; i++) {
    const slot = order[i];
    const lift = spread * 24 * (i / span);
    out[slot.index] = nearestOctave(slot.midi + lift, mod(slot.midi, 12)).midi;
  }
  return separate(out);
}

function topLift(frame: VoiceFrame): number {
  if (!frame.open.length) return 0;
  let index = 0;
  for (let i = 1; i < frame.open.length; i++) {
    if (frame.open[i] > frame.open[index] || (frame.open[i] === frame.open[index] && i > index)) index = i;
  }
  return (frame.notes[index] ?? frame.open[index]) - frame.open[index];
}

function voiceLeap(harmony: readonly HarmonicEvent[], frames: readonly VoiceFrame[], step: number): number {
  let event = 0;
  for (let i = 0; i < harmony.length; i++) {
    const start = Math.floor(harmony[i].startTick / SIXTEENTH_TICKS);
    if (start <= step) event = i;
  }
  const current = frames[step];
  if (!current) return 0;
  const previous = event === 0 ? harmony.length - 1 : event - 1;
  const prevStart = Math.floor(harmony[previous].startTick / SIXTEENTH_TICKS);
  const prevEnd = Math.min(frames.length - 1, prevStart + Math.max(1, Math.floor(harmony[previous].lengthTicks / SIXTEENTH_TICKS)) - 1);
  const before = frames[Math.max(0, prevEnd)];
  if (!before) return 0;
  const a = [...before.notes].sort((x, y) => x - y);
  const b = [...current.notes].sort((x, y) => x - y);
  let leap = 0;
  const count = Math.min(a.length, b.length);
  for (let i = 0; i < count; i++) leap = Math.max(leap, Math.abs(a[i] - b[i]));
  return leap;
}

function voiceTimeline(
  harmony: readonly HarmonicEvent[],
  steps: number,
  scale: readonly number[],
  keyRoot: number,
  read: VoiceRead,
): VoiceFrame[] {
  const total = Math.max(0, Math.round(steps));
  const empty = (): VoiceFrame => ({ notes: [], open: [] });
  if (total === 0 || harmony.length === 0) return Array.from({ length: total }, empty);
  let carry: VoiceCarry | null = null;
  let frames = Array.from({ length: total }, empty);
  for (let pass = 0; pass < 3; pass++) {
    const walked = walkVoices(harmony, total, scale, keyRoot, read, carry);
    frames = walked.frames;
    if (carry && walked.end && sameNotes(walked.end.notes, carry.notes)) break;
    if (walked.end) carry = walked.end;
  }
  return frames;
}

function walkVoices(
  harmony: readonly HarmonicEvent[],
  steps: number,
  scale: readonly number[],
  keyRoot: number,
  read: VoiceRead,
  carry: VoiceCarry | null,
): { frames: VoiceFrame[]; end: VoiceCarry | null } {
  const frames = Array.from({ length: steps }, () => ({ notes: [] as number[], open: [] as number[] }));
  let prev = carry;
  let end: VoiceCarry | null = carry;
  for (const harm of harmony) {
    const fns = chordFns(harm, scale, keyRoot);
    const start = Math.max(0, Math.min(steps - 1, Math.floor(harm.startTick / SIXTEENTH_TICKS)));
    const length = Math.max(1, Math.floor(harm.lengthTicks / SIXTEENTH_TICKS));
    const stop = Math.min(steps, start + length);
    const boundaryOct = read.octave(start);
    const close = closeVoicing(fns, boundaryOct);
    const parallel = prev ? parallelVoicing(prev, fns) : close;
    const nearest = prev ? nearestVoicing(prev, fns) : close;
    const memory = prev?.notes ?? parallel;
    let lastOpen = close;
    for (let step = start; step < stop; step++) {
      const flow = clamp01(read.flow(step));
      const blended = separate(blendVoices(parallel, nearest, flow, memory, fns));
      const shift = (octaveNumber(read.octave(step)) - octaveNumber(boundaryOct)) * 12;
      const open = separate(blended.map((note) => clampMidi(note + shift)));
      const notes = applySpread(open, clamp01(read.spread(step)));
      frames[step] = { notes, open };
      lastOpen = open;
    }
    // Spread is applied again on the next chord, so the memory stays the led voices.
    prev = { notes: lastOpen, rootPc: fns.rootPc };
    end = prev;
  }
  return { frames, end };
}

function liveReader(lane: ChordLane, macros: Record<string, number>): VoiceRead {
  return {
    spread: (step) => clamp01(evalModulated(withMacro(lane.spread, macro(macros, "spread")), step)),
    flow: (step) => clamp01(evalModulated(withMacro(lane.flow, macro(macros, "flow")), step)),
    octave: (step) => evalModulated(withMacro(lane.octave, macro(macros, "octave")), step),
  };
}

export function generatePhrase(project: Project): Phrase {
  const [a, b] = idleStamp(project);
  if (a === idleA && b === idleB && idlePhrase) return idlePhrase;
  const phrase = phraseOf(project, project.working);
  idleA = a;
  idleB = b;
  idlePhrase = phrase;
  return phrase;
}

function phraseOf(project: Project, working: Lanes): Phrase {
  soundHold = null;
  const { global, macros, lock } = project;
  const bassSteps = laneSteps(working, "bass", global);
  const leadSteps = laneSteps(working, "lead", global);
  const chordSteps = sixteenthSteps(global.phrase, global.bar);
  const harmony = generateHarmony(project.progression, global, Math.max(bassSteps, leadSteps, chordSteps));
  const lanes = {} as Phrase["lanes"];
  const steps = {} as Phrase["steps"];
  const voiced = new Set<LaneId>();
  for (const lane of LANES) {
    steps[lane] = laneSteps(working, lane, global);
    if (laneUsesVoice(working, lane)) voiced.add(lane);
    lanes[lane] = eventsFor(working, lane, global, lock[lane] ? {} : macros, harmony, steps[lane]);
  }
  const dry = { lanes, harmony, steps };
  const sources = voiceSources(working);
  if (sources.size === 0) return dry;
  const tempo = Math.max(1, project.global.tempo);
  const tables = dryTables(project, dry, sources, tempo);
  const sixteenth = tickToSample(SIXTEENTH_TICKS, tempo);
  const wetLanes = { ...lanes };
  hearVoices((pattern, step) => voiceEnvAt(tables, pattern, step * sixteenth), () => {
    for (const lane of voiced) {
      wetLanes[lane] = eventsFor(working, lane, global, lock[lane] ? {} : macros, harmony, steps[lane]);
    }
  });
  const wet = { lanes: wetLanes, harmony, steps };
  tablesOn.set(wet, tables);
  return wet;
}

function voiceEnvAt(tables: ReadonlyMap<LaneId, EnvelopeTable>, pattern: number, sample: number): number {
  const lane = voiceLane(pattern);
  const table = lane ? tables.get(lane) : undefined;
  return table ? readEnvelope(table, sample) : 0;
}

const tablesOn = new WeakMap<Phrase, ReadonlyMap<LaneId, EnvelopeTable>>();
let bakedEnv: { stamp: number; tables: Map<LaneId, EnvelopeTable> } | null = null;

/** Envelope painted while the phrase was built. The screen reads it instead of painting again. */
export function voiceTable(phrase: Phrase, lane: LaneId): EnvelopeTable | null {
  return tablesOn.get(phrase)?.get(lane) ?? null;
}

let drawnEnv: { phrase: Phrase; lane: LaneId; table: EnvelopeTable } | null = null;

/** The curve reads the same table the phrase used at each step. */
export function laneEnvelope(project: Project, phrase: Phrase, lane: LaneId): EnvelopeTable {
  if (drawnEnv && drawnEnv.phrase === phrase && drawnEnv.lane === lane) return drawnEnv.table;
  const attached = voiceTable(phrase, lane);
  if (attached) {
    drawnEnv = { phrase, lane, table: attached };
    return attached;
  }
  const tempo = Math.max(1, project.global.tempo);
  const table = envelopeTable(shapeHits(project, phrase, new Set([lane]), tempo), lane, tempo);
  drawnEnv = { phrase, lane, table };
  return table;
}

function dryTables(project: Project, phrase: Phrase, sources: ReadonlySet<LaneId>, tempo: number): Map<LaneId, EnvelopeTable> {
  const stamp = materialStamp(project, phrase, sources, tempo);
  if (bakedEnv && bakedEnv.stamp === stamp) return bakedEnv.tables;
  const hits = shapeHits(project, phrase, sources, tempo);
  const tables = new Map<LaneId, EnvelopeTable>();
  for (const lane of LANES) {
    if (!sources.has(lane)) continue;
    tables.set(lane, envelopeTable(hits, lane, tempo));
  }
  bakedEnv = { stamp, tables };
  return tables;
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

let soundHold: { sound: SoundKnobs; macros: Record<string, number>; read: (step: number) => Record<string, number> } | null = null;

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
  if (!soundHold || soundHold.sound !== sound || soundHold.macros !== macros) {
    soundHold = { sound, macros, read: bindSound(sound, macros) };
  }
  return soundHold.read(step);
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

/** Same spans as drumPitchHz. An octave is this far along the log knob. */
const DRUM_HZ: Record<DrumId, readonly [number, number]> = {
  kick: [32, 180],
  snare: [140, 900],
  hat: [250, 4000],
  perc: [70, 2500],
};

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

export interface ChordFigure {
  mode: "block" | "arp";
  ticks: number;
  /** Header while the rate value knob is held. */
  label: string;
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
    fillSlice(out, lane, harmony, global, macros, sound, filter, send, voiced, start, end, phraseTicks, blockKept);
  }
  return out;
}

/** A slice is the part of the hole that sounds. Rate fills it; the rest of the hole stays quiet. */
function fillSlice(
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
  const ranges: Array<[number, number]> = [];
  if (end <= phraseTicks) ranges.push([Math.max(0, start), end]);
  else {
    if (start < phraseTicks) ranges.push([Math.max(0, start), phraseTicks]);
    const tail = end - phraseTicks;
    if (tail > 0) ranges.push([0, Math.min(phraseTicks, tail)]);
  }
  const rateAt = rateAlong(lane, macros);
  for (const [from, to] of ranges) {
    if (to - from < 1) continue;
    for (const harm of harmony) {
      const a = Math.max(from, harm.startTick);
      const b = Math.min(to, harm.startTick + harm.lengthTicks);
      if (b - a < 1) continue;
      const notes = walkChord({ ...harm, startTick: a, lengthTicks: b - a }, (tick) => {
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
      }, rateAt, {
        block: blockKept,
        note: (tick, note) => rollChance(chanceAt(lane, macros, tick / SIXTEENTH_TICKS), global.seed, "note", tick, note),
      });
      for (const { note, delay, lengthTicks } of notes) {
        const at = a + delay;
        const rendered = soundValues(sound, at / SIXTEENTH_TICKS, macros);
        const heard = filterValues(filter, at / SIXTEENTH_TICKS, macros);
        const sent = sendValues(send, at / SIXTEENTH_TICKS, macros);
        const sample = tickToSample(at, global.tempo);
        out.push({
          lane: "chords",
          tick: at,
          sample,
          sampleOffset: sampleOffset(sample),
          note,
          velocity: evalModulated(withMacro(lane.velocity, macro(macros, "velocity")), at / SIXTEENTH_TICKS),
          lengthTicks,
          step: Math.floor(at / SIXTEENTH_TICKS),
          sound: rendered,
          filter: heard,
          send: sent,
        });
      }
    }
  }
}

type FigureAt = ChordFigure & { gate: number; note: number; voices: readonly number[] };

/**
 * Rate, gate, and tone are read once per note. Spread, flow, and octave are
 * already in the voicing, one frame per sixteenth. A block holds while that
 * set of pitches stays put and attacks again when a voice moves. Tone picks a
 * single function only while the figure is an arp.
 */
function nextSixteenth(tick: number): number {
  return (Math.floor(tick / SIXTEENTH_TICKS) + 1) * SIXTEENTH_TICKS;
}

function samePitchSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return sameNotes(left, right);
}

function pushVoices(
  hits: { note: number; delay: number; lengthTicks: number }[],
  notes: readonly number[],
  delay: number,
  lengthTicks: number,
): void {
  const room = Math.max(1, lengthTicks);
  for (const note of notes) hits.push({ note, delay, lengthTicks: room });
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

function walkChord(
  harm: HarmonicEvent,
  at: (tick: number) => FigureAt,
  rateAt: (tick: number) => ChordFigure,
  hear: { block: boolean; note: (tick: number, note: number) => boolean },
): { note: number; delay: number; lengthTicks: number }[] {
  const length = harm.lengthTicks;
  const hits: { note: number; delay: number; lengthTicks: number }[] = [];
  let cursor = 0;
  while (cursor < length) {
    const now = at(harm.startTick + cursor);
    if (now.mode === "block" || now.ticks <= 0) {
      const end = blockEnd(cursor, length, harm.startTick, rateAt);
      if (hear.block && now.voices.length) {
        let runFrom = cursor;
        let run = now.voices;
        let atTick = cursor;
        while (atTick < end) {
          const nextTick = Math.min(end, nextSixteenth(harm.startTick + atTick) - harm.startTick);
          const boundary = nextTick <= atTick ? Math.min(end, atTick + 1) : nextTick;
          if (boundary >= end) {
            pushVoices(hits, run, runFrom, end - runFrom);
            break;
          }
          const later = at(harm.startTick + boundary);
          if (!samePitchSet(later.voices, run)) {
            pushVoices(hits, run, runFrom, boundary - runFrom);
            runFrom = boundary;
            run = later.voices;
          }
          atTick = boundary;
        }
      }
      cursor = end;
      continue;
    }
    const step = Math.max(1, now.ticks);
    const next = Math.min(length, cursor + step);
    const gateTicks = Math.max(1, Math.round(step * clampGate(now.gate)));
    const room = Math.max(1, Math.min(gateTicks, next - cursor, length - cursor));
    if (hear.note(harm.startTick + cursor, now.note)) hits.push({ note: now.note, delay: cursor, lengthTicks: room });
    cursor = next;
  }
  return hits;
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

/** Leave a block on the sixteenth where rate steps out of it. */
function blockEnd(cursor: number, length: number, start: number, rateAt: (tick: number) => ChordFigure): number {
  let tick = Math.min(length, cursor + SIXTEENTH_TICKS);
  while (tick < length) {
    const later = rateAt(start + tick);
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
