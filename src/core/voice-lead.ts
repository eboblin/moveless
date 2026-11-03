import { clamp01, SIXTEENTH_TICKS, sixteenthSteps } from "./clock.ts";
import { generateHarmony, pitchClassOfDegree, scaleOf } from "./harmony.ts";
import { matchQuality } from "./latch.ts";
import { mod } from "./motif.ts";
import { hashPair } from "./phrase-cache.ts";
import {
  PROGRESSION_KEYS,
  QUALITY_SEMITONES,
  type ChordLane,
  type GlobalSettings,
  type HarmonicEvent,
  type Progression,
} from "./types.ts";

/**
 * Absolute tonic octave. 0 is C0 (MIDI 0). 9 is the piano's top C in this
 * numbering (MIDI 108). A0 sits in octave 1. Same ends on bass and lead.
 */
export const OCTAVE_MIN = 0;
export const OCTAVE_MAX = 9;

export function octaveNumber(unit: number): number {
  return OCTAVE_MIN + Math.round(clamp01(unit) * (OCTAVE_MAX - OCTAVE_MIN));
}

export interface ChordFigure {
  mode: "block" | "arp";
  ticks: number;
  /** Header while the rate value knob is held. */
  label: string;
}

export interface VoiceFrame {
  /** Function order, after the octave shift and spread. */
  notes: number[];
  /** The same voices before spread. */
  open: number[];
}

interface VoiceCarry {
  notes: number[];
  rootPc: number;
}

export interface VoiceRead {
  spread: (step: number) => number;
  flow: (step: number) => number;
  octave: (step: number) => number;
}

interface ChordFns {
  rootPc: number;
  semis: readonly number[];
  pcs: readonly number[];
}

export type FigureAt = ChordFigure & { gate: number; note: number; voices: readonly number[] };

function valueReader(lane: ChordLane): VoiceRead {
  return {
    spread: () => clamp01(lane.spread.value),
    flow: () => clamp01(lane.flow.value),
    octave: () => lane.octave.value,
  };
}

let valueKeyA = 0;
let valueKeyB = 0;
let valueFrames: VoiceFrame[] | null = null;
let valueHarmony: HarmonicEvent[] | null = null;

/** Value-only spelling. The tone cell and the spread/flow header share one walk per paint. */
export function valueVoices(
  lane: ChordLane,
  progression: Progression,
  global: GlobalSettings,
): { frames: VoiceFrame[]; harmony: HarmonicEvent[] } {
  const [a, b] = hashPair((mix, text) => {
    mix(lane.spread.value);
    mix(lane.flow.value);
    mix(lane.octave.value);
    for (const key of PROGRESSION_KEYS) mix(progression[key]);
    text(global.scale);
    mix(global.root);
    mix(global.transpose);
    mix(global.bar);
    mix(global.phrase);
    mix(global.seed);
  });
  if (valueFrames && valueHarmony && a === valueKeyA && b === valueKeyB) {
    return { frames: valueFrames, harmony: valueHarmony };
  }
  const steps = sixteenthSteps(global.phrase, global.bar);
  const harmony = generateHarmony(progression, global, steps);
  const frames = voiceTimeline(harmony, steps, scaleOf(global.scale), mod(global.root + global.transpose, 12), valueReader(lane));
  valueKeyA = a;
  valueKeyB = b;
  valueFrames = frames;
  valueHarmony = harmony;
  return { frames, harmony };
}

export function valueVoiceAt(lane: ChordLane, progression: Progression, global: GlobalSettings, step: number): VoiceFrame | null {
  const { frames } = valueVoices(lane, progression, global);
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
 * The search buffer is reused: a chord spelling runs on every knob turn.
 */
const coverMidi: number[] = [];
const coverDist: number[] = [];
const coverUsed: boolean[] = [];
const coverChoice: number[] = [];
const coverBest: number[] = [];
const coverFrom: number[] = [];
const coverPcs: number[] = [];
const coverJob = {
  m: 0,
  n: 0,
  rootPc: 0,
  preferLeap: false,
  bestKey: 0,
  bestLeap: 0,
  bestLow: 0,
};

function cover(sources: readonly number[], fns: ChordFns, preferLeap: boolean, from: readonly number[]): number[] {
  const pcs = fns.pcs;
  const m = pcs.length;
  const n = sources.length;
  if (m === 0 || n === 0) return [];
  const job = coverJob;
  job.m = m;
  job.n = n;
  job.rootPc = fns.rootPc;
  job.preferLeap = preferLeap;
  job.bestKey = Number.POSITIVE_INFINITY;
  job.bestLeap = Number.POSITIVE_INFINITY;
  job.bestLow = Number.POSITIVE_INFINITY;
  if (coverChoice.length < m) coverChoice.length = m;
  if (coverBest.length < m) coverBest.length = m;
  if (coverUsed.length < n) coverUsed.length = n;
  if (coverFrom.length < n) coverFrom.length = n;
  if (coverPcs.length < m) coverPcs.length = m;
  const pairs = n * m;
  if (coverMidi.length < pairs) coverMidi.length = pairs;
  if (coverDist.length < pairs) coverDist.length = pairs;
  for (let fi = 0; fi < m; fi++) coverPcs[fi] = pcs[fi];
  for (let s = 0; s < n; s++) {
    coverUsed[s] = false;
    coverFrom[s] = from[s] ?? sources[s];
    for (let fi = 0; fi < m; fi++) {
      const hit = nearestOctave(sources[s], pcs[fi]);
      const slot = s * m + fi;
      coverMidi[slot] = hit.midi;
      coverDist[slot] = hit.dist;
    }
  }
  coverWalk(0, 0, 0, 0);
  const won = new Array<number>(m);
  for (let i = 0; i < m; i++) won[i] = coverBest[i];
  return separate(won);
}

function coverFinish(cost: number, leap: number, low: number): void {
  const job = coverJob;
  const better = cost < job.bestKey - 1e-6
    || (Math.abs(cost - job.bestKey) <= 1e-6 && (job.preferLeap ? leap < job.bestLeap - 1e-6 : low < job.bestLow))
    || (Math.abs(cost - job.bestKey) <= 1e-6 && job.preferLeap && Math.abs(leap - job.bestLeap) <= 1e-6 && low < job.bestLow);
  if (!better) return;
  job.bestKey = cost;
  job.bestLeap = leap;
  job.bestLow = low;
  for (let i = 0; i < job.m; i++) coverBest[i] = coverChoice[i];
}

function coverPlaceRest(fi: number, rootMidi: number, cost: number, leap: number, low: number): void {
  const job = coverJob;
  for (let i = fi; i < job.m; i++) {
    const semi = mod(coverPcs[i] - job.rootPc, 12);
    coverChoice[i] = clampMidi(rootMidi + semi);
    low += coverChoice[i];
  }
  coverFinish(cost, leap, low);
}

function coverWalk(fi: number, cost: number, leap: number, low: number): void {
  const job = coverJob;
  if (cost > job.bestKey + 1e-6) return;
  if (fi === job.m) {
    coverFinish(cost, leap, low);
    return;
  }
  let open = false;
  const m = job.m;
  for (let s = 0; s < job.n; s++) {
    if (coverUsed[s]) continue;
    open = true;
    coverUsed[s] = true;
    const slot = s * m + fi;
    const midi = coverMidi[slot];
    coverChoice[fi] = midi;
    coverWalk(fi + 1, cost + coverDist[slot], leap + Math.abs(midi - coverFrom[s]), low + midi);
    coverUsed[s] = false;
  }
  if (!open) coverPlaceRest(fi, coverChoice[0] ?? octaveNumber(0) * 12 + job.rootPc, cost, leap, low);
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

export function topLift(frame: VoiceFrame): number {
  if (!frame.open.length) return 0;
  let index = 0;
  for (let i = 1; i < frame.open.length; i++) {
    if (frame.open[i] > frame.open[index] || (frame.open[i] === frame.open[index] && i > index)) index = i;
  }
  return (frame.notes[index] ?? frame.open[index]) - frame.open[index];
}

export function voiceLeap(harmony: readonly HarmonicEvent[], frames: readonly VoiceFrame[], step: number): number {
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

export function voiceTimeline(
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
  const frames = new Array<VoiceFrame>(steps);
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
    let openFlow = 0;
    let openShift = 0;
    let openNotes = close;
    let haveOpen = false;
    let shared: VoiceFrame | null = null;
    let sharedSpread = 0;
    for (let step = start; step < stop; step++) {
      const flow = clamp01(read.flow(step));
      const shift = (octaveNumber(read.octave(step)) - octaveNumber(boundaryOct)) * 12;
      const spread = clamp01(read.spread(step));
      // The boundary spelling depends on flow and the octave shift. Spread only
      // opens that spelling, so a steady chord is one search for the whole hold.
      if (!haveOpen || flow !== openFlow || shift !== openShift) {
        const blended = separate(blendVoices(parallel, nearest, flow, memory, fns));
        openNotes = shift === 0 ? blended : separate(blended.map((note) => clampMidi(note + shift)));
        openFlow = flow;
        openShift = shift;
        haveOpen = true;
        shared = null;
      }
      if (!shared || spread !== sharedSpread) {
        shared = { notes: applySpread(openNotes, spread), open: openNotes };
        sharedSpread = spread;
      }
      frames[step] = shared;
      lastOpen = openNotes;
    }
    // Spread is applied again on the next chord, so the memory stays the led voices.
    prev = { notes: lastOpen, rootPc: fns.rootPc };
    end = prev;
  }
  return { frames, end };
}

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

function clampGate(gate: number): number {
  if (gate < 0.05) return 0.05;
  if (gate > 1) return 1;
  return gate;
}

/**
 * Rate, gate, and tone are read once per note. Spread, flow, and octave are
 * already in the voicing, one frame per sixteenth. A block holds while that
 * set of pitches stays put and attacks again when a voice moves. Tone picks a
 * single function only while the figure is an arp.
 */
export function walkChord(
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

export interface SliceHit {
  note: number;
  tick: number;
  lengthTicks: number;
}

/**
 * A slice is the part of the hole that sounds. Rate fills it; the rest of the hole stays quiet.
 * Hits come back with an absolute tick so the phrase can attach sound and filter.
 */
export function fillSlice(
  harmony: readonly HarmonicEvent[],
  start: number,
  end: number,
  phraseTicks: number,
  blockKept: boolean,
  at: (tick: number) => FigureAt,
  rateAt: (tick: number) => ChordFigure,
  hearNote: (tick: number, note: number) => boolean,
): SliceHit[] {
  const ranges: Array<[number, number]> = [];
  if (end <= phraseTicks) ranges.push([Math.max(0, start), end]);
  else {
    if (start < phraseTicks) ranges.push([Math.max(0, start), phraseTicks]);
    const tail = end - phraseTicks;
    if (tail > 0) ranges.push([0, Math.min(phraseTicks, tail)]);
  }
  const placed: SliceHit[] = [];
  for (const [from, to] of ranges) {
    if (to - from < 1) continue;
    for (const harm of harmony) {
      const a = Math.max(from, harm.startTick);
      const b = Math.min(to, harm.startTick + harm.lengthTicks);
      if (b - a < 1) continue;
      const notes = walkChord({ ...harm, startTick: a, lengthTicks: b - a }, at, rateAt, {
        block: blockKept,
        note: hearNote,
      });
      for (const { note, delay, lengthTicks } of notes) {
        placed.push({ note, tick: a + delay, lengthTicks });
      }
    }
  }
  return placed;
}
