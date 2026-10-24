import { clamp01, SAMPLE_RATE, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { formatDeckCommand, type DeckCommand } from "../core/deck.ts";
import { defaultBus, defaultFx } from "../core/defaults.ts";
import { applyVoiceEnvelope, evalModulated, voiceLane } from "../core/modulate.ts";
import { isDrum, LANES, type Bus, type Fx, type LaneId } from "../core/types.ts";
import { commandDeck, createDeckRuntime, deckTargetLead, deckThrow, hearDeck, writeDeckBlock, type DeckRuntime } from "./deck.ts";
import { envelopeTable, hatDecaySeconds, kickDecaySeconds, percDecaySeconds, readEnvelope, snareBodyDecaySeconds, snareNoiseDecaySeconds, type EnvelopeTable } from "./envelope.ts";

export { hatDecaySeconds, kickDecaySeconds, percDecaySeconds, snareBodyDecaySeconds, snareNoiseDecaySeconds };
import type { EngineParam } from "./map.ts";
import type { BlockEvent, LoopEvent, Motion } from "./schedule.ts";
import { clearEcho, clearTank, createEcho, createTank, echoSample, tankSample, type Echo, type Tank } from "./fx.ts";

const TWO_PI = Math.PI * 2;
const DRUM_COUNT = 4;
const NOTE_COUNT = 12;
const LANE_COUNT = 8;
const LANE_MOTION_CAP = 12;
const WT_FRAMES = 48;
const WT_CYCLE = 256;
const WT_MIPS = 7;
const WT_HARM = 64;
const WT_ANCHOR = [0, 0.22, 0.42, 0.62, 0.82, 1];
/** Shared loudness. A peak-normalized sine was as hot as a saw and a block slammed soft(). */
const WT_RMS = 1 / Math.sqrt(2);
/** One voice used to sit at 0.38. A block of tones needs room under the bus soft clip. */
const NOTE_LEVEL = 0.22;
const UNI_CENTS = 25;
const UNI_PAN = 0.35;

const P_NONE = 0;
const P_FREQ = 1;
const P_DECAY = 2;
const P_PBEND = 3;
const P_BTIME = 4;
const P_BODY = 5;
const P_CLICK = 6;
const P_NOISE = 7;
const P_DIST = 8;
const P_BDCY = 9;
const P_NDCY = 10;
const P_SNAP = 11;
const P_TONE = 12;
const P_METAL = 13;
const P_COLOR = 14;
const P_ATK = 15;
const P_RING = 16;
const P_POS = 17;
const P_MAT = 18;
const P_FM = 19;
const P_RATIO = 20;
const P_DAMP = 21;
const P_WAVE = 22;
const P_BEND = 23;
const P_SYNC = 24;
const P_FOLD = 25;
const P_CUTOFF = 26;
const P_RESONANCE = 27;
const P_ATTACK = 28;
const P_RELEASE = 29;
const P_WIDE = 30;
const P_REVERB = 31;
const P_DELAY = 32;
const P_NOTE_DRIVE = 33;
const P_GLIDE = 34;
const P_PLUCK = 35;
const P_ENV = 36;
const LANE_HAT = 2;
const LANE_PERC = 3;
const LANE_BASS = 4;
const LANE_LEAD = 5;
const LANE_CHORDS = 6;
const HAAS_N = 544;
const TILT_COEF = 1 - Math.exp((-TWO_PI * 1000) / SAMPLE_RATE);
const GLUE_ATTACK = 1 - Math.exp(-1 / (0.015 * SAMPLE_RATE));
const GLUE_RELEASE = 1 - Math.exp(-1 / (0.15 * SAMPLE_RATE));

export interface Engine {
  noise: number;
  drums: DrumVoice[];
  notes: NoteVoice[];
  phrase: LoopEvent[];
  motions: Motion[];
  clock: number;
  tempo: number;
  beats: number;
  fx: Fx;
  /** Final mix. Zero on every knob is a wire around the sum. */
  bus: Bus;
  /** Kick envelope. 1 on the hit, then it falls across an eighth note. */
  pumpEnv: number;
  glueGain: number;
  tiltL: number;
  tiltR: number;
  tank: Tank;
  echo: Echo;
  /** Pitched-note timing of the phrase last loaded. Same grid must not re-attack. */
  holdSig: string;
  lanes: LaneBox[];
  /** Master platter. The shadow is a second voice kept ahead of this clock. */
  deck: DeckRuntime;
  deckShadow: Engine | null;
  /** Last sounded frequency of each lane, so a fresh glide still starts from it. */
  laneFreq: number[];
  /** Voices claimed while arming one sample. */
  armSerial: number;
  armClock: number;
  /** Baked voice-pattern envelopes. Null until some live motion asks for that lane. */
  env: (EnvelopeTable | null)[];
}

interface DrumVoice {
  on: boolean;
  lane: number;
  phase0: number;
  phase1: number;
  phase2: number;
  phase3: number;
  clickPhase: number;
  env: number;
  noiseEnv: number;
  pitchEnv: number;
  clickEnv: number;
  age: number;
  /** Base Hz, stamped at the hit. */
  freq: number;
  /** Body amplitude time, seconds. Hat metal is lengthened by `ring` on top of this. */
  decay: number;
  noiseDecay: number;
  /** Pitch-envelope time, seconds. Independent of `decay` on the kick. */
  bendTime: number;
  /** Downward pitch sweep in octaves. */
  bend: number;
  /** Spectrum macro: kick/snare body, hat metal, perc material. */
  body: number;
  noise: number;
  /** Spectral tilt. Kick derives it from body; snare tone and hat color write it. */
  tone: number;
  /** Transient amount: kick click, snare snap, hat/perc attack. */
  click: number;
  drive: number;
  /** Extra FM index. The spectrum macro can add its own. */
  fm: number;
  /** Musical modulator ratio. */
  ratio: number;
  ring: number;
  /** Hat pan. 0 left, 0.5 center, 1 right. */
  pos: number;
  damp: number;
  cutoff: number;
  resonance: number;
  reverb: number;
  delay: number;
  nlp: number;
  nhp: number;
  flt: number;
  band: number;
  loop: number;
  envK: number;
  noiseK: number;
  pitchK: number;
  clickK: number;
  /** Hit level. Body and noise envelopes already start here; the transient has its own shape and uses this as a gain. */
  gain: number;
  /** Short stereo delay for perc. Kick, snare and hat leave it unused. */
  haas: Float32Array;
  haasI: number;
}

interface NoteVoice {
  on: boolean;
  /** Master phase of the center reader and the two unison sides. */
  phase: number[];
  /** Hard-sync reader, one per unison copy. */
  slave: number[];
  env: number;
  /** Release ring under a pluck. The body stays in `env`. */
  tail: number;
  age: number;
  left: number;
  freq: number;
  wave: number;
  bend: number;
  sync: number;
  fold: number;
  drive: number;
  wide: number;
  /** Pitch glide time, 0..1. Zero jumps. */
  glide: number;
  /** Amplitude pluck, 0..1. Zero holds until the gate ends. */
  pluck: number;
  pluckK: number;
  /** Filter-envelope depth. The running contour is `filterEnv`. */
  envAmt: number;
  filterEnv: number;
  /** Frequency the glide is chasing. `freq` is where the oscillator is now. */
  target: number;
  /** Arm batch. A chord note must not claim a sibling armed on this sample. */
  claim: number;
  cutoff: number;
  resonance: number;
  reverb: number;
  delay: number;
  attack: number;
  release: number;
  gain: number;
  low: number;
  band: number;
  lane: number;
  /** MIDI note, stamped at note on. Chord spread reads it. */
  pitch: number;
  loop: number;
  releaseK: number;
  /** Short stereo delay for the lead. Bass and chords leave it unused. */
  haas: Float32Array;
  haasI: number;
}

interface LaneMotion {
  param: number;
  pattern: number;
  value: number;
  cycle: number;
  amount: number;
}

interface LaneBox {
  live: LaneMotion[];
  still: LaneMotion[];
}

export function createEngine(): Engine {
  return {
    noise: 1,
    drums: Array.from({ length: DRUM_COUNT }, emptyDrum),
    notes: Array.from({ length: NOTE_COUNT }, emptyNote),
    phrase: [],
    motions: [],
    clock: 0,
    tempo: 120,
    beats: 4,
    fx: defaultFx(),
    bus: defaultBus(),
    pumpEnv: 0,
    glueGain: 1,
    tiltL: 0,
    tiltR: 0,
    tank: createTank(),
    echo: createEcho(),
    holdSig: "",
    lanes: emptyLanes(),
    deck: createDeckRuntime(),
    deckShadow: null,
    laneFreq: Array.from({ length: LANE_COUNT }, () => 0),
    armSerial: 0,
    armClock: -1,
    env: Array.from({ length: 7 }, () => null),
  };
}

/** Store a looping phrase. `reset` starts the audio clock at the downbeat. */
export function loadPhrase(engine: Engine, events: LoopEvent[], tempo: number, reset: boolean, motions: Motion[] = []): void {
  const sig = holdSig(events);
  const previous = engine.holdSig;
  engine.phrase = events;
  engine.motions = motions;
  engine.tempo = Math.max(1, tempo);
  engine.holdSig = sig;
  bucketMotions(engine, motions);
  bakeEnvelopes(engine);
  stampHeld(engine);
  engine.deckShadow = null;
  engine.deck.lead = 0;
  if (reset) {
    engine.clock = 0;
    engine.deck.filled = 0;
    engine.deck.peakL.fill(0);
    engine.deck.peakR.fill(0);
    engine.deck.gesture = null;
    engine.deck.command = null;
    engine.deck.up = null;
    clearTank(engine.tank);
    clearEcho(engine.echo);
    clearBusState(engine);
    return;
  }
  if (engine.clock > 0 && sig !== previous) catchHolding(engine);
}

/** Notes already under the playhead when a knob rebuilds the grid. Drums stay put. Length is not part of the grid: a sounding note keeps the length it started with, and the next note-on reads the new one. */
function holdSig(events: LoopEvent[]): string {
  let sig = "";
  for (const event of events) {
    if (isDrum(event.lane)) continue;
    sig += `${event.lane}:${event.sample}:${event.loop}:${event.note};`;
  }
  return sig;
}

function catchHolding(engine: Engine): void {
  const tempo = Math.max(1, engine.tempo);
  for (const event of engine.phrase) {
    if (isDrum(event.lane)) continue;
    const loop = Math.max(1, event.loop);
    const pos = ((engine.clock % loop) + loop) % loop;
    const start = ((event.sample % loop) + loop) % loop;
    const dur = Math.max(1, Math.round((event.lengthTicks * SAMPLE_RATE * 60) / (tempo * 192)));
    let elapsed = pos - start;
    if (elapsed < 0) elapsed += loop;
    if (elapsed <= 0 || elapsed >= dur) continue;
    const note = armNote(engine, event, dur - elapsed, loop);
    note.left = dur - elapsed;
  }
}

/** One shared-memory write: a phrase the voice loops on its own sample clock. */
export function packPhrase(events: LoopEvent[], tempo: number, reset: boolean, motions: Motion[] = []): string {
  return `P|${tempo}|${reset ? 1 : 0}|${packPhraseBody(events, motions)}`;
}

/** Four bus knobs, already the heard values. Rides after the fx trailer. */
export function formatBus(bus: Bus): string {
  return [bus.glue, bus.pump, bus.wide, bus.tilt].map((n) => n.toFixed(4)).join(",");
}

export function packPhraseBody(events: LoopEvent[], motions: Motion[] = [], fx = "", bus = ""): string {
  const body = events.map((event) => {
    const lane = LANES.indexOf(event.lane);
    const params = event.params.map((param) => `${param.id}=${param.value.toFixed(4)}`).join(",");
    return `${event.sample}:${event.loop}:${lane}:${event.note}:${event.velocity}:${event.lengthTicks}:${params}`;
  }).join(";");
  if (!motions.length) {
    const packed = fx ? `${body}@${fx}` : body;
    return bus ? `${packed}^${bus}` : packed;
  }
  const tail = motions.map((motion) => {
    const lane = LANES.indexOf(motion.lane);
    const head = `${lane}:${motion.id}:${motion.value.toFixed(4)}:${Math.round(motion.pattern)}:${Math.round(motion.cycle)}:${motion.amount.toFixed(4)}:${motion.loop}`;
    return head;
  }).join(";");
  const packed = fx ? `${body}#${tail}@${fx}` : `${body}#${tail}`;
  return bus ? `${packed}^${bus}` : packed;
}

/** Bass, Lead and Chords share these twelve notes. Drums keep one voice each. */
export function renderBlock(engine: Engine, events: BlockEvent[], tempo: number, frames = 128): Float32Array {
  return renderFrames(engine, frames, (frame) => {
    for (const event of events) {
      if (event.sampleOffset === frame) trigger(engine, event, Math.max(1, tempo));
    }
  });
}

const FOLLOW_STRIDE = 8;

/** Advance the voice clock by real audio frames and retrigger the stored phrase. */
export function renderClock(engine: Engine, frames = 128): Float32Array {
  const out = playBlock(engine, frames, false);
  fillDeckAhead(engine, frames);
  return out;
}

/**
 * One block of the master the platter stores: after the bus, before the deck
 * and the soft clip. The first frame is sample `clock + 1`.
 */
export function renderDryBlock(engine: Engine, frames = 128): Float32Array {
  return playBlock(engine, frames, true);
}

/**
 * Arm whatever is already sounding at `sample`, then leave the clock so the
 * next rendered frame is stored at that index. The live engine's first frame is index 1.
 */
export function placeClock(engine: Engine, sample: number): void {
  const at = Math.max(1, Math.floor(sample));
  for (const drum of engine.drums) drum.on = false;
  for (const note of engine.notes) note.on = false;
  engine.clock = at;
  catchHolding(engine);
  engine.clock = at - 1;
  clearTank(engine.tank);
  clearEcho(engine.echo);
  clearBusState(engine);
}

/** One block of the phrase clock. `ahead` skips the platter and the soft clip so the cushion can be stored raw. */
function playBlock(engine: Engine, frames: number, ahead: boolean): Float32Array {
  const tempo = engine.tempo;
  const fires: { offset: number; event: (typeof engine.phrase)[number] }[] = [];
  const C = engine.clock;
  for (const event of engine.phrase) {
    const loop = Math.max(1, event.loop);
    const mod = ((C % loop) + loop) % loop;
    let t0 = event.sample - mod;
    if (t0 < 0) t0 += loop;
    for (let t = t0; t < frames; t += loop) fires.push({ offset: t, event });
  }
  fires.sort((a, b) => a.offset - b.offset);
  let fi = 0;
  return renderFrames(engine, frames, (frame) => {
    while (fi < fires.length && fires[fi].offset === frame) {
      trigger(engine, fires[fi].event, tempo);
      fi += 1;
    }
    engine.clock += 1;
  }, ahead);
}

function renderFrames(engine: Engine, frames: number, at: (frame: number) => void, ahead = false): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    at(i);
    if ((i & (FOLLOW_STRIDE - 1)) === 0) follow(engine);
    const wide = engine.bus.wide;
    let chordLo = 128;
    let chordHi = -1;
    if (wide > 0) {
      for (const note of engine.notes) {
        if (!note.on || note.lane !== LANE_CHORDS) continue;
        if (note.pitch < chordLo) chordLo = note.pitch;
        if (note.pitch > chordHi) chordHi = note.pitch;
      }
    }
    let left = 0;
    let right = 0;
    let revL = 0;
    let revR = 0;
    let dlyL = 0;
    let dlyR = 0;
    for (const drum of engine.drums) {
      if (!drum.on) continue;
      const pair = placeDrum(drum, drumSample(engine, drum), wide);
      left += pair[0];
      right += pair[1];
      revL += pair[0] * drum.reverb;
      revR += pair[1] * drum.reverb;
      dlyL += pair[0] * drum.delay;
      dlyR += pair[1] * drum.delay;
    }
    for (const note of engine.notes) {
      if (!note.on) continue;
      let pair = placeNote(note, noteSample(engine, note), wide, chordLo, chordHi);
      pair = pumpPair(engine, note.lane, pair);
      left += pair[0];
      right += pair[1];
      revL += pair[0] * note.reverb;
      revR += pair[1] * note.reverb;
      dlyL += pair[0] * note.delay;
      dlyR += pair[1] * note.delay;
    }
    const thrown = ahead ? 0 : deckThrow(engine.deck, engine.clock, engine.tempo);
    if (thrown > 0) {
      dlyL += left * thrown;
      dlyR += right * thrown;
    }
    const wetR = tankSample(engine.tank, engine.fx.reverb, revL, revR);
    const wetD = echoSample(engine.echo, engine.fx.delay, engine.beats, engine.tempo, dlyL, dlyR);
    const mixed = glueMix(engine, tiltMix(engine, left + wetR[0] + wetD[0], right + wetR[1] + wetD[1]));
    const heard = ahead ? mixed : hearDeck(engine.deck, engine.clock, engine.tempo, mixed[0], mixed[1]);
    out[i * 2] = ahead ? heard[0] : soft(heard[0]);
    out[i * 2 + 1] = ahead ? heard[1] : soft(heard[1]);
    decayPump(engine);
  }
  return out;
}

/**
 * While the deck screen is up, render at most two extra blocks into the ring
 * so a reverse or a double can read audio that has not been heard yet.
 * One of those blocks keeps pace with the live clock; the other grows the lead
 * until it covers a bar. The shadow is dropped when the screen and the gesture are both gone.
 */
function fillDeckAhead(engine: Engine, frames: number): void {
  const deck = engine.deck;
  if (deck.bypass) return;
  if (!deck.warm && !deck.gesture) {
    engine.deckShadow = null;
    deck.lead = 0;
    return;
  }
  if (!engine.deckShadow) engine.deckShadow = cloneDeckShadow(engine);
  const target = deckTargetLead(engine.tempo, deck.barBeats);
  const extra = deck.lead + frames < target ? 2 : 1;
  const shadow = engine.deckShadow;
  for (let n = 0; n < extra; n++) {
    const start = shadow.clock + 1;
    const audio = playBlock(shadow, frames, true);
    writeDeckBlock(deck, start, audio);
  }
  deck.lead = Math.max(0, shadow.clock - engine.clock);
}

function cloneDeckShadow(engine: Engine): Engine {
  const savedShadow = engine.deckShadow;
  const ringL = engine.deck.ringL;
  const ringR = engine.deck.ringR;
  engine.deckShadow = null;
  engine.deck.ringL = new Float32Array(0);
  engine.deck.ringR = new Float32Array(0);
  const copy = structuredClone(engine);
  engine.deckShadow = savedShadow;
  engine.deck.ringL = ringL;
  engine.deck.ringR = ringR;
  copy.deckShadow = null;
  copy.deck.bypass = true;
  copy.deck.ringL = ringL;
  copy.deck.ringR = ringR;
  return copy;
}

/** Apply a `D|...` record. The same text is what `dsp.so` reads. */
export function applyDeckCommand(engine: Engine, command: DeckCommand): void {
  engine.deck.knobs = command.knobs;
  engine.deck.warm = command.warm;
  engine.deck.seed = command.seed;
  engine.deck.barBeats = command.barBeats;
  commandDeck(engine.deck, command.gesture, engine.clock, command.press ?? 0);
}

export function formatDeck(command: DeckCommand): string {
  return formatDeckCommand(command);
}

function clearHaas(voice: { haas: Float32Array; haasI: number }): void {
  voice.haas.fill(0);
  voice.haasI = 0;
}

function clearBusState(engine: Engine): void {
  engine.pumpEnv = 0;
  engine.glueGain = 1;
  engine.tiltL = 0;
  engine.tiltR = 0;
  for (const drum of engine.drums) clearHaas(drum);
  for (const note of engine.notes) clearHaas(note);
}

/** Hat pan law. Center keeps both channels at full level. */
function panGains(pos: number): [number, number] {
  const x = Math.max(0, Math.min(1, pos));
  const left = x <= 0.5 ? 1 : (1 - x) * 2;
  const right = x >= 0.5 ? 1 : x * 2;
  return [left, right];
}

function placeDrum(drum: DrumVoice, pair: [number, number], wide: number): [number, number] {
  if (wide <= 0) return pair;
  if (drum.lane === LANE_HAT) return openHat(pair, drum.pos, wide);
  if (drum.lane === LANE_PERC) return haas(drum, pair, wide);
  return pair;
}

function placeNote(note: NoteVoice, pair: [number, number], wide: number, lo: number, hi: number): [number, number] {
  if (wide <= 0) return pair;
  if (note.lane === LANE_CHORDS) return panChord(pair, note.pitch, lo, hi, wide);
  if (note.lane === LANE_LEAD) return haas(note, pair, wide);
  return pair;
}

/** Pull an existing hat pan further off center. A centered hat stays put. */
function openHat(pair: [number, number], pos: number, wide: number): [number, number] {
  const opened = Math.max(0, Math.min(1, 0.5 + (pos - 0.5) * (1 + wide)));
  const [pl, pr] = panGains(pos);
  const [ol, orr] = panGains(opened);
  const mono = pl > 1e-4 ? pair[0] / pl : pr > 1e-4 ? pair[1] / pr : 0;
  return [mono * ol, mono * orr];
}

/** Low chord tone toward the left, high chord tone toward the right. One tone stays centered. */
function panChord(pair: [number, number], pitch: number, lo: number, hi: number, wide: number): [number, number] {
  const t = hi > lo ? (pitch - lo) / (hi - lo) : 0.5;
  const [gl, gr] = panGains(0.5 + (t - 0.5) * wide);
  const mid = (pair[0] + pair[1]) * 0.5;
  const side = (pair[0] - pair[1]) * 0.5;
  return [mid * gl + side, mid * gr - side];
}

/** Delay one channel by up to 12 ms. Wide 0 is not called. */
function haas(voice: { haas: Float32Array; haasI: number }, pair: [number, number], wide: number): [number, number] {
  const mid = (pair[0] + pair[1]) * 0.5;
  let delay = Math.round(wide * 0.012 * SAMPLE_RATE);
  if (delay < 1) delay = 1;
  if (delay >= HAAS_N) delay = HAAS_N - 1;
  let pos = voice.haasI - delay;
  if (pos < 0) pos += HAAS_N;
  const delayed = voice.haas[pos];
  voice.haas[voice.haasI] = mid;
  voice.haasI += 1;
  if (voice.haasI >= HAAS_N) voice.haasI = 0;
  return [pair[0], pair[1] * (1 - wide) + delayed * wide];
}

function pumpPair(engine: Engine, lane: number, pair: [number, number]): [number, number] {
  if (engine.bus.pump <= 0 || engine.pumpEnv <= 0) return pair;
  if (lane !== LANE_BASS && lane !== LANE_CHORDS) return pair;
  const gain = 1 - engine.bus.pump * engine.pumpEnv;
  return [pair[0] * gain, pair[1] * gain];
}

function decayPump(engine: Engine): void {
  if (engine.pumpEnv <= 0) return;
  const eighth = (SAMPLE_RATE * 30) / Math.max(1, engine.tempo);
  engine.pumpEnv = Math.max(0, engine.pumpEnv - 1 / eighth);
}

/** One pole around 1 kHz. Zero tilt returns the sample unchanged. */
function tiltMix(engine: Engine, left: number, right: number): [number, number] {
  engine.tiltL += (left - engine.tiltL) * TILT_COEF;
  engine.tiltR += (right - engine.tiltR) * TILT_COEF;
  const tilt = engine.bus.tilt;
  if (tilt === 0) return [left, right];
  return [left + tilt * (left - 2 * engine.tiltL), right + tilt * (right - 2 * engine.tiltR)];
}

/** Round peaks, then a slow glue compressor. Zero is a wire. */
function glueMix(engine: Engine, pair: [number, number]): [number, number] {
  const glue = engine.bus.glue;
  if (glue <= 0) return pair;
  const level = Math.max(Math.abs(pair[0]), Math.abs(pair[1]));
  const threshold = 1 - glue * 0.85;
  const ratio = 1 + glue * 3;
  let target = 1;
  if (level > threshold && level > 1e-8) target = (threshold + (level - threshold) / ratio) / level;
  const coef = target < engine.glueGain ? GLUE_ATTACK : GLUE_RELEASE;
  engine.glueGain += (target - engine.glueGain) * coef;
  const makeup = 1 + glue * 0.35;
  const gain = engine.glueGain * makeup;
  return [shave(pair[0] * gain, glue), shave(pair[1] * gain, glue)];
}

/** Small signals pass. Peaks fold down as glue rises. */
function shave(x: number, glue: number): number {
  const k = glue * 2.5;
  return Math.tanh(x * (1 + k)) / (1 + k);
}

/** One shared-memory write: tempo, then the events of this audio block. */
export function packBlock(events: BlockEvent[], tempo: number): string {
  const body = events.map((event) => {
    const lane = LANES.indexOf(event.lane);
    const params = event.params.map((param) => `${param.id}=${param.value.toFixed(4)}`).join(",");
    return `${event.sampleOffset}:${lane}:${event.note}:${event.velocity}:${event.lengthTicks}:${params}`;
  }).join(";");
  return `${tempo}|${body}`;
}

function trigger(engine: Engine, event: BlockEvent | LoopEvent, tempo: number): void {
  const loop = "loop" in event ? event.loop : 0;
  if (event.lane === "kick" || event.lane === "snare" || event.lane === "hat" || event.lane === "perc") {
    const drum = engine.drums[drumIndex(event.lane)];
    const pitch = read(event.params, ["freq"], 0.5);
    armDrum(drum, event, pitch, loop);
    if (event.lane === "kick") engine.pumpEnv = 1;
    if (event.lane === "perc") clearHaas(drum);
    return;
  }
  const samples = Math.max(1, Math.round((event.lengthTicks * SAMPLE_RATE * 60) / (tempo * 192)));
  armNote(engine, event, samples, loop);
}

function armDrum(drum: DrumVoice, event: BlockEvent | LoopEvent, pitch: number, loop: number): void {
  const lane = drumIndex(event.lane);
  const vel = event.velocity / 127;
  drum.gain = vel;
  drum.on = true;
  drum.lane = lane;
  drum.phase0 = 0;
  drum.phase1 = 0;
  drum.phase2 = 0;
  drum.phase3 = 0;
  drum.clickPhase = 0;
  drum.env = vel;
  drum.noiseEnv = vel;
  drum.pitchEnv = 1;
  drum.age = 0;
  drum.freq = drumPitchHz(lane, pitch);
  drum.loop = loop;
  drum.nlp = 0;
  drum.nhp = 0;
  drum.flt = 0;
  drum.band = 0;
  drum.fm = 0;
  drum.ratio = 1;
  drum.ring = 0;
  drum.pos = 0.5;
  drum.damp = 0;
  drum.drive = 0;
  if (lane === 0) {
    drum.decay = kickDecaySeconds(knob(event, "decay", 0.4));
    drum.noiseDecay = 0.045;
    drum.bend = knob(event, "pbend", 0.4) * 3;
    drum.bendTime = bendTimeSeconds(knob(event, "btime", 0.4));
    drum.body = knob(event, "body", 0.1);
    drum.click = knob(event, "click", 0.1);
    drum.noise = knob(event, "noise", 0.1);
    drum.tone = 0.12 + drum.body * 0.35;
    drum.drive = knob(event, "dist", 0.05);
    drum.damp = 0.2;
  } else if (lane === 1) {
    drum.body = knob(event, "body", 0.3);
    drum.decay = snareBodyDecaySeconds(knob(event, "bdcy", 0.3));
    drum.noise = knob(event, "noise", 0.5);
    drum.noiseDecay = snareNoiseDecaySeconds(knob(event, "ndcy", 0.3));
    drum.click = knob(event, "snap", 0.4);
    drum.tone = knob(event, "tone", 0.5);
    drum.drive = knob(event, "dist", 0.1);
    const bend = snarePitchBend(drum.body);
    drum.bend = bend.bend;
    drum.bendTime = bend.bendTime;
    drum.ratio = 1.4 + drum.body * 0.8;
    drum.damp = 0;
  } else if (lane === 2) {
    drum.body = knob(event, "metal", 0.5);
    drum.noise = knob(event, "noise", 0.5);
    drum.tone = knob(event, "color", 0.5);
    drum.decay = hatDecaySeconds(knob(event, "decay", 0.3));
    drum.noiseDecay = drum.decay;
    drum.click = knob(event, "atk", 0.3);
    drum.ring = knob(event, "ring", 0.3);
    drum.pos = knob(event, "pos", 0.5);
    drum.bend = 0;
    drum.bendTime = 0.05;
  } else {
    drum.body = knob(event, "mat", 0.2);
    drum.decay = percDecaySeconds(knob(event, "decay", 0.4));
    drum.noiseDecay = Math.min(0.09, drum.decay * 0.4);
    drum.bend = knob(event, "pbend", 0.1) * 3.5;
    drum.bendTime = Math.max(0.03, drum.decay * 0.7);
    drum.fm = knob(event, "fm", 0);
    drum.ratio = fmRatioOf(knob(event, "ratio", 0.06));
    drum.click = knob(event, "atk", 0.3);
    drum.damp = knob(event, "damp", 0.4);
    drum.noise = percNoiseAmt(drum.body);
    drum.tone = percTone(drum.body);
  }
  drum.clickEnv = drum.click > 0.001 ? 1 : 0;
  drum.cutoff = read(event.params, ["cutoff"], 0.5);
  drum.resonance = read(event.params, ["resonance"], 0);
  drum.reverb = read(event.params, ["reverb"], 0);
  drum.delay = read(event.params, ["delay"], 0);
  refreshDrumEnv(drum);
}

function midiFreq(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

/** One arming batch per sample, so a chord does not hand its first voice to the next note. */
function beginArm(engine: Engine): number {
  if (engine.armClock !== engine.clock) {
    engine.armClock = engine.clock;
    engine.armSerial += 1;
  }
  return engine.armSerial;
}

/** Nearest sounding voice of this lane. Other lanes stay put. */
function glideVoice(engine: Engine, lane: number, pitch: number, serial: number): NoteVoice | null {
  let best: NoteVoice | null = null;
  let bestDist = Infinity;
  for (const note of engine.notes) {
    if (!note.on || note.age === 0 || note.lane !== lane || note.claim === serial) continue;
    const dist = Math.abs(note.pitch - pitch);
    if (dist < bestDist) {
      best = note;
      bestDist = dist;
    }
  }
  return best;
}

function paintNote(note: NoteVoice, event: BlockEvent | LoopEvent, samples: number, loop: number): void {
  note.lane = LANES.indexOf(event.lane);
  note.pitch = event.note;
  note.loop = loop;
  note.left = samples;
  note.target = midiFreq(event.note);
  note.wave = read(event.params, ["wave"], 0.36);
  note.bend = read(event.params, ["bend"], 0);
  note.sync = read(event.params, ["sync"], 0);
  note.fold = read(event.params, ["fold"], 0);
  note.drive = read(event.params, ["drive"], 0);
  note.cutoff = read(event.params, ["cutoff"], 0.5);
  note.resonance = read(event.params, ["resonance"], 0);
  note.reverb = read(event.params, ["reverb"], 0);
  note.delay = read(event.params, ["delay"], 0);
  note.attack = read(event.params, ["attack"], 0);
  note.release = read(event.params, ["release", "decay"], 0.4);
  note.wide = read(event.params, ["wide"], 0);
  note.glide = read(event.params, ["glide"], 0);
  note.pluck = read(event.params, ["pluck"], 0);
  note.envAmt = read(event.params, ["env"], 0);
  note.gain = event.velocity / 127;
  refreshRelease(note);
  refreshPluck(note);
}

function armNote(engine: Engine, event: BlockEvent | LoopEvent, samples: number, loop: number): NoteVoice {
  const serial = beginArm(engine);
  const lane = LANES.indexOf(event.lane);
  const glide = read(event.params, ["glide"], 0);
  const prior = glide > 1e-4 ? glideVoice(engine, lane, event.note, serial) : null;
  const legato = prior !== null && prior.left > 0;
  const note = prior ?? steal(engine);
  note.on = true;
  if (!legato) {
    note.env = 0;
    note.tail = 0;
    note.age = 0;
    note.filterEnv = 1;
    if (!prior) {
      for (let copy = 0; copy < 3; copy++) {
        note.phase[copy] = unisonPhase(event.note, lane, engine.clock | 0, copy);
        note.slave[copy] = 0;
      }
      clearHaas(note);
      note.low = 0;
      note.band = 0;
      const target = midiFreq(event.note);
      const remembered = engine.laneFreq[lane] ?? 0;
      note.freq = glide > 1e-4 && remembered > 1 ? remembered : target;
    }
  }
  paintNote(note, event, samples, loop);
  if (glide <= 1e-4) note.freq = note.target;
  note.claim = serial;
  stampNote(engine, note);
  return note;
}

function drumSample(engine: Engine, drum: DrumVoice): [number, number] {
  const freq = drum.freq * 2 ** (drum.bend * drum.pitchEnv);
  const body = drum.lane === 2 ? hatBody(drum, freq) : tonalBody(drum, freq);
  const noisy = noiseSample(engine, drum) * drum.noiseEnv;
  const click = transientSample(engine, drum) * drum.gain;
  let mid = body.mid * drum.env + noisy + click;
  let side = body.side * drum.env;
  if (drum.drive > 1e-4) {
    const amount = drum.drive * drum.drive;
    mid = shapeDrive(mid, amount);
    side = shapeDrive(side, amount);
  }
  const slot = { low: drum.flt, band: drum.band };
  const filtered = filterSample(slot, mid, drum.cutoff, drum.resonance);
  drum.flt = slot.low;
  drum.band = slot.band;
  drum.env *= drum.envK;
  drum.noiseEnv *= drum.noiseK;
  drum.pitchEnv *= drum.pitchK;
  drum.age += 1;
  if (drum.env < 0.0008 && drum.noiseEnv < 0.0008 && drum.clickEnv < 0.0008 && drum.age > 64) drum.on = false;
  if (drum.lane === 2) {
    const [left, right] = hatPan(drum.pos);
    return [filtered * left, filtered * right];
  }
  return [filtered + side, filtered - side];
}

/** 0 hard left, 0.5 center, 1 hard right. Center keeps both channels at full level. */
function hatPan(pos: number): [number, number] {
  const x = Math.max(0, Math.min(1, pos));
  const left = x <= 0.5 ? 1 : (1 - x) * 2;
  const right = x >= 0.5 ? 1 : x * 2;
  return [left, right];
}

function shapeNote(sample: number, fold: number, drive: number): number {
  let mix = sample;
  if (fold > 1e-4) {
    const folded = Math.sin(mix * (1 + fold * fold * 4));
    mix += (folded - mix) * fold;
  }
  if (drive > 1e-4) {
    const amount = drive * drive * 5;
    const driven = mix * (1 + amount);
    mix = driven / (1 + amount * Math.abs(mix));
  }
  return mix;
}

/**
 * Wide 0 is the center reader alone. Above that, two side readers grow in
 * with the square of the knob and sit symmetrically around the note. Full wide
 * is three equal copies. The weights are power-normalized so the chord does not get louder.
 */
/** Pluck time. 0 holds. The first knob step is about 0.6 s, the top about 30 ms. */
export function pluckSeconds(unit: number): number {
  if (unit <= 1e-4) return 0;
  const t = Math.min(1, Math.max(0, (unit - 0.01) / 0.99));
  return 0.6 * (0.03 / 0.6) ** t;
}

/** Release ring under a pluck, quieter than the hit so the pluck stays the attack. */
const PLUCK_TAIL = 0.4;

/** Glide time. 0 jumps. The first knob step is about 60 ms, the top about 0.5 s. */
export function glideSeconds(unit: number): number {
  if (unit <= 1e-4) return 0;
  const t = Math.min(1, Math.max(0, (unit - 0.01) / 0.99));
  return 0.06 * (0.5 / 0.06) ** t;
}

/**
 * Filter contour. ENV 0 leaves the cutoff knob alone. Above that the attack
 * opens toward 0.5 by ENV, and the rest is the knob when it is already a
 * low-pass, otherwise a darker floor `0.5 + ENV·0.45`.
 */
export function melodyCutoff(cutoff: number, env: number, contour: number): number {
  if (env <= 1e-4) return cutoff;
  const rest = cutoff > 0.5 ? cutoff : 0.5 + env * 0.45;
  return rest + (0.5 - rest) * env * contour;
}

function slewNote(note: NoteVoice): void {
  const tau = glideSeconds(note.glide);
  if (!(tau > 0) || !(note.freq > 0)) {
    note.freq = note.target;
    return;
  }
  const k = 1 - Math.exp(-1 / (tau * SAMPLE_RATE));
  const logF = Math.log(note.freq);
  const logT = Math.log(Math.max(note.target, 1e-6));
  note.freq = Math.exp(logF + (logT - logF) * k);
}

function noteSample(engine: Engine, note: NoteVoice): [number, number] {
  slewNote(note);
  const inc = (TWO_PI * note.freq) / SAMPLE_RATE;
  const open = note.wide > 1e-4;
  const indexes = open ? [0, 1, 2] : [1];
  let power = 0;
  for (const index of indexes) power += unisonWeight(note.wide, index) ** 2;
  const norm = 1 / Math.sqrt(power);
  let mid = 0;
  let side = 0;
  for (const index of indexes) {
    const weight = unisonWeight(note.wide, index);
    const cents = unisonCents(note.wide, index);
    const ratio = cents === 0 ? 1 : 2 ** (cents / 1200);
    const shaped = shapeNote(advanceOsc(note, index, inc * ratio, note.sync, note.bend, note.wave), note.fold, note.drive);
    const scaled = shaped * weight;
    mid += scaled;
    side += scaled * unisonPan(note.wide, index);
  }
  mid *= norm;
  side *= norm;
  const resonated = filterSample(note, mid, melodyCutoff(note.cutoff, note.envAmt, note.filterEnv), note.resonance);
  const attackSamples = 1 + note.attack * 0.2 * SAMPLE_RATE;
  // Pluck 0 holds full level for the gate, then release.
  // Above zero the body falls on the pluck. Release keeps a quieter tail from the same attack.
  if (note.pluck > 1e-4) {
    if (note.age < attackSamples) {
      note.env = (note.age + 1) / attackSamples;
      note.tail = note.env;
    } else {
      if (note.tail < note.env) note.tail = note.env;
      note.env *= note.pluckK;
      note.tail *= note.releaseK;
    }
  } else if (note.left > 0 && note.age < attackSamples) note.env = (note.age + 1) / attackSamples;
  else if (note.left > 0) note.env = 1;
  else note.env *= note.releaseK;
  const level = note.pluck > 1e-4 ? Math.max(note.env, note.tail * PLUCK_TAIL) : note.env;
  const contour = note.pluck > 1e-4 ? pluckSeconds(note.pluck) : 0.15;
  note.filterEnv *= Math.exp(-1 / (contour * SAMPLE_RATE));
  note.age += 1;
  if (note.left > 0) note.left -= 1;
  const quiet = note.age >= attackSamples && level < 0.0008;
  if (note.pluck > 1e-4) {
    if (quiet) note.on = false;
  } else if (note.left <= 0 && quiet) note.on = false;
  if (note.freq > 1) engine.laneFreq[note.lane] = note.freq;
  const gain = resonated * level * note.gain * NOTE_LEVEL;
  const sided = side * level * note.gain * NOTE_LEVEL;
  return [gain + sided, gain - sided];
}

function gauss(k: number, center: number, sigma: number): number {
  const d = (k - center) / sigma;
  return Math.exp(-d * d);
}

/** Integer partial at one spectral anchor. Kind 0..5 is dark, triangle, saw, square, pulse, vowel. */
function anchorAmp(kind: number, k: number): number {
  if (kind === 0) return 1 / (k * k);
  if (kind === 1) {
    if (k % 2 === 0) return 0;
    return (k % 4 === 1 ? 1 : -1) / (k * k);
  }
  if (kind === 2) return 1 / k;
  if (kind === 3) return k % 2 === 1 ? 1 / k : 0;
  if (kind === 4) return Math.sin(Math.PI * k * 0.12) / k;
  return 0.22 / k ** 1.5 + gauss(k, 3, 0.9) + 0.75 * gauss(k, 8, 1.2) + 0.55 * gauss(k, 14, 1.5);
}

function ampAt(p: number, k: number): number {
  if (p <= 0) return anchorAmp(0, k);
  if (p >= 1) return anchorAmp(5, k);
  let i = 0;
  while (i < 4 && p > WT_ANCHOR[i + 1]) i += 1;
  const span = WT_ANCHOR[i + 1] - WT_ANCHOR[i];
  const t = span > 0 ? (p - WT_ANCHOR[i]) / span : 0;
  return anchorAmp(i, k) * (1 - t) + anchorAmp(i + 1, k) * t;
}

function buildWaveTable(): Float32Array {
  const table = new Float32Array(WT_MIPS * WT_FRAMES * WT_CYCLE);
  const amp = new Float64Array(WT_HARM + 1);
  for (let mip = 0; mip < WT_MIPS; mip++) {
    const maxH = WT_HARM >> mip;
    for (let frame = 0; frame < WT_FRAMES; frame++) {
      const p = frame / (WT_FRAMES - 1);
      for (let k = 1; k <= maxH; k++) amp[k] = ampAt(p, k);
      let energy = 0;
      const base = (mip * WT_FRAMES + frame) * WT_CYCLE;
      for (let n = 0; n < WT_CYCLE; n++) {
        const theta = (TWO_PI * n) / WT_CYCLE;
        let sum = 0;
        for (let k = 1; k <= maxH; k++) sum += amp[k] * Math.sin(k * theta);
        table[base + n] = sum;
        energy += sum * sum;
      }
      const rms = Math.sqrt(energy / WT_CYCLE);
      if (rms > 1e-8) {
        const norm = WT_RMS / rms;
        for (let n = 0; n < WT_CYCLE; n++) table[base + n] *= norm;
      }
    }
  }
  return table;
}

const WAVE_TABLE = buildWaveTable();

function readCycle(mip: number, frame: number, u: number): number {
  const pos = u * WT_CYCLE;
  const i0 = Math.floor(pos) % WT_CYCLE;
  const frac = pos - Math.floor(pos);
  const i1 = (i0 + 1) % WT_CYCLE;
  const base = (mip * WT_FRAMES + frame) * WT_CYCLE;
  const a = WAVE_TABLE[base + i0];
  const b = WAVE_TABLE[base + i1];
  return a + (b - a) * frac;
}

function readWave(freq: number, wave: number, u: number): number {
  const fit = Math.min(WT_HARM, Math.max(1, (SAMPLE_RATE * 0.45) / Math.max(freq, 1)));
  const mipF = Math.log2(WT_HARM / fit);
  let m0 = Math.floor(mipF);
  if (m0 < 0) m0 = 0;
  if (m0 > WT_MIPS - 1) m0 = WT_MIPS - 1;
  const top = m0 >= WT_MIPS - 1;
  const m1 = top ? m0 : m0 + 1;
  const mf = top ? 0 : mipF - m0;
  const pos = Math.max(0, Math.min(1, wave)) * (WT_FRAMES - 1);
  let f0 = Math.floor(pos);
  if (f0 >= WT_FRAMES - 1) f0 = WT_FRAMES - 2;
  const ff = pos - f0;
  const s0 = readCycle(m0, f0, u) * (1 - ff) + readCycle(m0, f0 + 1, u) * ff;
  if (mf < 1e-4) return s0;
  const s1 = readCycle(m1, f0, u) * (1 - ff) + readCycle(m1, f0 + 1, u) * ff;
  return s0 + (s1 - s0) * mf;
}

function bendUnit(u: number, bend: number): number {
  if (bend <= 1e-4 || u <= 0) return u;
  return u ** (1 + bend * bend * 3);
}

function unisonWeight(wide: number, index: number): number {
  if (wide <= 1e-4 || index === 1) return 1;
  return wide * wide;
}

function unisonCents(wide: number, index: number): number {
  if (wide <= 1e-4 || index === 1) return 0;
  return (index === 0 ? -wide : wide) * UNI_CENTS;
}

function unisonPan(wide: number, index: number): number {
  if (wide <= 1e-4 || index === 1) return 0;
  return (index === 0 ? -UNI_PAN : UNI_PAN);
}

/** Low 32 bits of a product. Matches uint32_t multiply in dsp/src/voice.c. */
function u32mul(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = (a >>> 16) & 0xffff;
  const b0 = b & 0xffff;
  const b1 = (b >>> 16) & 0xffff;
  return ((a0 * b0) + (((a0 * b1 + a1 * b0) & 0xffff) << 16)) >>> 0;
}

/** Note-on phase. Same integer mix as unison_phase in dsp/src/voice.c. */
function unisonPhase(pitch: number, lane: number, sample: number, copy: number): number {
  let h = (u32mul(pitch, 0x16566731) + u32mul(lane, 0x27d4eb2f) + u32mul(sample >>> 0, 0x85ebca77) + u32mul(copy, 0xc2b2ae35)) >>> 0;
  h = u32mul(h ^ (h >>> 16), 0x7feb352d);
  h = u32mul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 4294967296) * TWO_PI;
}

function advanceOsc(
  note: NoteVoice,
  index: number,
  inc: number,
  sync: number,
  bend: number,
  wave: number,
): number {
  let phase = note.phase[index] + inc;
  let wrapped = false;
  if (phase >= TWO_PI) {
    phase -= TWO_PI;
    if (phase >= TWO_PI) phase %= TWO_PI;
    wrapped = true;
  }
  note.phase[index] = phase;
  let u: number;
  let readFreq: number;
  if (sync > 1e-4) {
    const ratio = 1 + sync * sync * 4;
    let slave = note.slave[index];
    if (wrapped) slave = 0;
    else {
      slave += inc * ratio;
      if (slave >= TWO_PI) slave %= TWO_PI;
    }
    note.slave[index] = slave;
    u = slave / TWO_PI;
    readFreq = (inc * ratio * SAMPLE_RATE) / TWO_PI;
  } else {
    u = phase / TWO_PI;
    readFreq = (inc * SAMPLE_RATE) / TWO_PI;
  }
  return readWave(readFreq, wave, bendUnit(u, bend));
}

function shapeDrive(sample: number, drive: number): number {
  const gain = 1 + drive * 8;
  const driven = sample * gain;
  return driven / (1 + Math.abs(driven));
}

function follow(engine: Engine): void {
  const pos = engine.clock - 1;
  if (pos < 0) return;
  const span = Math.max(1, tickToSample(SIXTEENTH_TICKS, engine.tempo));
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const box = engine.lanes[lane];
    if (!box.live.length) continue;
    const loop = laneLoop(engine, lane);
    if (loop < 1) continue;
    const step = (pos % loop) / span;
    const at = pos % loop;
    const units = box.live.map((motion) => evalMotion(engine, motion, step, at));
    if (lane < DRUM_COUNT) {
      const drum = engine.drums[lane];
      for (let m = 0; m < box.live.length; m++) applyDrum(drum, box.live[m].param, units[m]);
    } else {
      for (const note of engine.notes) {
        if (!note.on || note.lane !== lane || note.loop < 1) continue;
        for (let m = 0; m < box.live.length; m++) applyNote(note, box.live[m].param, units[m]);
      }
    }
  }
}

function laneLoop(engine: Engine, lane: number): number {
  if (lane < DRUM_COUNT) {
    const drum = engine.drums[lane];
    return drum.on && drum.loop > 0 ? drum.loop : 0;
  }
  for (const note of engine.notes) {
    if (note.on && note.lane === lane && note.loop > 0) return note.loop;
  }
  return 0;
}

function applyDrum(drum: DrumVoice, param: number, unit: number): void {
  const u = Math.max(0, Math.min(1, unit));
  if (param === P_DECAY) {
    if (drum.lane === 2) {
      drum.decay = hatDecaySeconds(u);
      drum.noiseDecay = drum.decay;
    } else if (drum.lane === 3) {
      drum.decay = percDecaySeconds(u);
      drum.noiseDecay = Math.min(0.09, drum.decay * 0.4);
      drum.bendTime = Math.max(0.03, drum.decay * 0.7);
    } else drum.decay = kickDecaySeconds(u);
    refreshDrumEnv(drum);
  } else if (param === P_BDCY) {
    drum.decay = snareBodyDecaySeconds(u);
    refreshDrumEnv(drum);
  } else if (param === P_NDCY) {
    drum.noiseDecay = snareNoiseDecaySeconds(u);
    refreshDrumEnv(drum);
  } else if (param === P_PBEND) drum.bend = u * (drum.lane === 3 ? 3.5 : 3);
  else if (param === P_BTIME) {
    drum.bendTime = bendTimeSeconds(u);
    refreshDrumEnv(drum);
  } else if (param === P_BODY || param === P_MAT || param === P_METAL) {
    drum.body = u;
    if (drum.lane === 0) drum.tone = 0.12 + u * 0.35;
    if (drum.lane === 1) {
      drum.ratio = 1.4 + u * 0.8;
      const bend = snarePitchBend(u);
      drum.bend = bend.bend;
      drum.bendTime = bend.bendTime;
      refreshDrumEnv(drum);
    }
    if (drum.lane === 3) {
      drum.noise = percNoiseAmt(u);
      drum.tone = percTone(u);
    }
  } else if (param === P_CLICK || param === P_SNAP || param === P_ATK) {
    drum.click = u;
    refreshDrumEnv(drum);
  } else if (param === P_NOISE) drum.noise = u;
  else if (param === P_DIST) drum.drive = u;
  else if (param === P_TONE || param === P_COLOR) drum.tone = u;
  else if (param === P_RING) {
    drum.ring = u;
    refreshDrumEnv(drum);
  } else if (param === P_POS) drum.pos = u;
  else if (param === P_FM) drum.fm = u;
  else if (param === P_RATIO) drum.ratio = fmRatioOf(u);
  else if (param === P_DAMP) drum.damp = u;
  else if (param === P_CUTOFF) drum.cutoff = u;
  else if (param === P_RESONANCE) drum.resonance = u;
  else if (param === P_REVERB) drum.reverb = u;
  else if (param === P_DELAY) drum.delay = u;
}

function applyNote(note: NoteVoice, param: number, unit: number): void {
  if (param === P_WAVE) note.wave = unit;
  else if (param === P_BEND) note.bend = unit;
  else if (param === P_SYNC) note.sync = unit;
  else if (param === P_FOLD) note.fold = unit;
  else if (param === P_NOTE_DRIVE) note.drive = unit;
  else if (param === P_CUTOFF) note.cutoff = unit;
  else if (param === P_RESONANCE) note.resonance = unit;
  else if (param === P_REVERB) note.reverb = unit;
  else if (param === P_DELAY) note.delay = unit;
  else if (param === P_ATTACK) note.attack = unit;
  else if (param === P_RELEASE) {
    note.release = unit;
    refreshRelease(note);
  } else if (param === P_WIDE) note.wide = unit;
  else if (param === P_GLIDE) note.glide = unit;
  else if (param === P_PLUCK) {
    note.pluck = unit;
    refreshPluck(note);
  } else if (param === P_ENV) note.envAmt = unit;
}

function refreshDrumEnv(drum: DrumVoice): void {
  const bodySec = drum.lane === 2 ? drum.decay * (1 + drum.ring * 2.8) : drum.decay;
  drum.envK = Math.exp(-1 / (Math.max(0.004, bodySec) * SAMPLE_RATE));
  drum.noiseK = Math.exp(-1 / (Math.max(0.003, drum.noiseDecay) * SAMPLE_RATE));
  drum.pitchK = Math.exp(-1 / (Math.max(0.004, drum.bendTime) * SAMPLE_RATE));
  const clickSamples = drum.lane === 1 ? 40 + (1 - drum.click) ** 1.4 * 700 : 12 + drum.click * 520;
  drum.clickK = Math.exp(-1 / Math.max(1, clickSamples));
}

function refreshRelease(note: NoteVoice): void {
  note.releaseK = Math.exp(-1 / ((0.04 + note.release * 1.6) * SAMPLE_RATE));
}

function refreshPluck(note: NoteVoice): void {
  const sec = pluckSeconds(note.pluck);
  note.pluckK = sec > 0 ? Math.exp(-1 / (sec * SAMPLE_RATE)) : 1;
}

const Q_MIN = 0.707;
const Q_MAX = 14;

/** Peaks above the passband squash into a thick acid tone instead of a spike. */
function clipPeak(x: number): number {
  const a = Math.abs(x);
  if (a <= 1.25) return x;
  const y = 1.25 + (a - 1.25) / (1 + (a - 1.25));
  return x < 0 ? -y : y;
}

/**
 * One knob, two filters. 0.5 is dry. Below that a resonant high-pass opens
 * toward 0, above it a resonant low-pass closes toward 1. Distance from the
 * center is squared. Resonance is the peak on that corner: the top of the
 * knob is an acid sweep, and that peak is not level-matched away.
 * `low` and `band` are the two integrators. Drums keep them in `flt`/`band`,
 * apart from the tone low-pass.
 */
export function filterSample(state: { low: number; band: number }, input: number, cutoff: number, resonance: number): number {
  const offset = cutoff - 0.5;
  const amount = Math.min(1, Math.abs(offset) * 2);
  if (amount < 1e-4) {
    state.low = 0;
    state.band = 0;
    return input;
  }
  const shaped = amount * amount;
  const lp = offset > 0;
  const hz = lp ? 12000 * (90 / 12000) ** shaped : 40 * (7000 / 40) ** shaped;
  const q = Q_MIN * (Q_MAX / Q_MIN) ** Math.max(0, Math.min(1, resonance));
  const g = Math.tan((Math.PI * Math.min(hz, SAMPLE_RATE * 0.45)) / SAMPLE_RATE);
  const k = 1 / q;
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = input - state.low;
  const v1 = a1 * state.band + a2 * v3;
  const v2 = state.low + a2 * state.band + a3 * v3;
  state.band = 2 * v1 - state.band;
  state.low = 2 * v2 - state.low;
  const raw = lp ? v2 : input - k * v1 - v2;
  const trim = lp ? 1 + shaped * 0.5 : 1 + shaped * 2.5;
  return clipPeak(raw * trim);
}

function evalMotion(engine: Engine, motion: LaneMotion, step: number, at: number): number {
  const source = voiceLane(motion.pattern);
  if (!source) {
    return evalModulated({
      value: motion.value,
      pattern: motion.pattern,
      cycle: motion.cycle,
      amount: motion.amount,
    }, step);
  }
  if (motion.amount === 0) return clamp01(motion.value);
  const index = LANES.indexOf(source);
  const table = index >= 0 ? engine.env[index] : null;
  const env = table ? readEnvelope(table, at) : 0;
  return applyVoiceEnvelope(motion.value, env, motion.amount);
}

function bakeEnvelopes(engine: Engine): void {
  const need = new Set<LaneId>();
  for (const box of engine.lanes) {
    for (const motion of box.live) {
      const lane = voiceLane(motion.pattern);
      if (lane) need.add(lane);
    }
  }
  const env: (EnvelopeTable | null)[] = Array.from({ length: 7 }, () => null);
  for (const lane of need) {
    const index = LANES.indexOf(lane);
    if (index >= 0) env[index] = envelopeTable(engine.phrase, lane, engine.tempo);
  }
  engine.env = env;
}

function bucketMotions(engine: Engine, motions: Motion[]): void {
  engine.lanes = emptyLanes();
  for (const motion of motions) {
    const lane = LANES.indexOf(motion.lane);
    const param = paramOf(motion.id);
    if (lane < 0 || lane >= LANE_COUNT || param === P_NONE || param === P_FREQ) continue;
    const box = engine.lanes[lane];
    const live = motion.amount !== 0;
    const list = live ? box.live : box.still;
    if (list.length >= LANE_MOTION_CAP) continue;
    list.push({
      param,
      pattern: motion.pattern,
      value: motion.value,
      cycle: motion.cycle,
      amount: motion.amount,
    });
  }
}

function stampHeld(engine: Engine): void {
  for (const note of engine.notes) {
    if (note.on) stampNote(engine, note);
  }
}

function stampNote(engine: Engine, note: NoteVoice): void {
  if (note.lane < DRUM_COUNT || note.lane >= LANE_COUNT) return;
  for (const motion of engine.lanes[note.lane].still) {
    applyNote(note, motion.param, Math.max(0, Math.min(1, motion.value)));
  }
}

function paramOf(id: string): number {
  if (id === "wave") return P_WAVE;
  if (id === "bend") return P_BEND;
  if (id === "sync") return P_SYNC;
  if (id === "fold") return P_FOLD;
  if (id === "drive") return P_NOTE_DRIVE;
  if (id === "cutoff") return P_CUTOFF;
  if (id === "resonance") return P_RESONANCE;
  if (id === "reverb") return P_REVERB;
  if (id === "delay") return P_DELAY;
  if (id === "attack") return P_ATTACK;
  if (id === "release" || id === "decay") return P_RELEASE;
  if (id === "wide") return P_WIDE;
  if (id === "glide") return P_GLIDE;
  if (id === "pluck") return P_PLUCK;
  if (id === "env") return P_ENV;
  if (ends(id, "freq")) return P_FREQ;
  if (ends(id, "btime")) return P_BTIME;
  if (ends(id, "pbend")) return P_PBEND;
  if (ends(id, "bdcy")) return P_BDCY;
  if (ends(id, "ndcy")) return P_NDCY;
  if (ends(id, "decay")) return P_DECAY;
  if (ends(id, "click")) return P_CLICK;
  if (ends(id, "noise")) return P_NOISE;
  if (ends(id, "dist")) return P_DIST;
  if (ends(id, "body")) return P_BODY;
  if (ends(id, "snap")) return P_SNAP;
  if (ends(id, "tone")) return P_TONE;
  if (ends(id, "metal")) return P_METAL;
  if (ends(id, "color")) return P_COLOR;
  if (ends(id, "atk")) return P_ATK;
  if (ends(id, "ring")) return P_RING;
  if (ends(id, "pos")) return P_POS;
  if (ends(id, "ratio")) return P_RATIO;
  if (ends(id, "damp")) return P_DAMP;
  if (ends(id, "mat")) return P_MAT;
  if (ends(id, "fm")) return P_FM;
  return P_NONE;
}

function ends(id: string, suffix: string): boolean {
  return id === suffix || id.endsWith(`_${suffix}`);
}

function emptyLanes(): LaneBox[] {
  return Array.from({ length: LANE_COUNT }, () => ({ live: [], still: [] }));
}

function soft(sample: number): number {
  const scaled = sample * 0.35;
  return scaled / (1 + Math.abs(scaled));
}

/**
 * A block arms every tone before any of them renders, so each new one still
 * has age 0 and a silent envelope. Stealing the quietest voice would take the
 * tone just armed and leave a single voice once releases fill the pool.
 */
function steal(engine: Engine): NoteVoice {
  let quietRelease: NoteVoice | null = null;
  let oldestHeld: NoteVoice | null = null;
  for (const note of engine.notes) {
    if (!note.on) return note;
    if (note.age === 0) continue;
    if (note.left <= 0) {
      if (!quietRelease || note.env < quietRelease.env) quietRelease = note;
    } else if (!oldestHeld || note.age > oldestHeld.age) {
      oldestHeld = note;
    }
  }
  return quietRelease ?? oldestHeld ?? engine.notes[0];
}

function read(params: EngineParam[], keys: string[], fallback: number): number {
  for (const key of keys) {
    const found = params.find((param) => param.id === key || param.id.endsWith(`_${key}`));
    if (found) return found.value;
  }
  return fallback;
}

function knob(event: BlockEvent | LoopEvent, key: string, fallback: number): number {
  return Math.max(0, Math.min(1, read(event.params, [key], fallback)));
}

/** Kick 32–180 Hz, snare 140–900, hat 250–4000, perc 70–2500. The knob is the pitch, not the MIDI note. */
export function drumPitchHz(lane: number, unit: number): number {
  const u = Math.max(0, Math.min(1, unit));
  const span = (lo: number, hi: number) => lo * (hi / lo) ** u;
  if (lane === 1) return span(140, 900);
  if (lane === 2) return span(250, 4000);
  if (lane === 3) return span(70, 2500);
  return span(32, 180);
}

function squaredSeconds(unit: number, lo: number, span: number): number {
  const u = Math.max(0, Math.min(1, unit));
  return lo + u * u * span;
}

export function bendTimeSeconds(unit: number): number {
  return squaredSeconds(unit, 0.008, 0.392);
}

/** The 808/909 shelf is the octave pair. It carries a short drop; wood and metal stay put. */
function snarePitchBend(body: number): { bend: number; bendTime: number } {
  const distance = Math.abs(body - 0.28);
  if (distance >= 0.1) return { bend: 0, bendTime: 0.02 };
  return { bend: 0.4 * (1 - distance / 0.1), bendTime: 0.02 };
}

const FM_STOPS = [1, 1.5, 2, 3, 4, 5, 7];
const FM_CENTER = [0.06, 0.21, 0.36, 0.51, 0.66, 0.81, 0.96];

/** Plateaus around 1, 1.5, 2, 3, 4, 5 and 7. A step of 0.05 stays on the same shelf. */
export function fmRatioOf(unit: number): number {
  const u = Math.max(0, Math.min(1, unit));
  for (let i = 0; i < FM_STOPS.length; i++) {
    if (Math.abs(u - FM_CENTER[i]) <= 0.055) return FM_STOPS[i];
  }
  if (u <= FM_CENTER[0]) return FM_STOPS[0];
  for (let i = 0; i < FM_STOPS.length - 1; i++) {
    const left = FM_CENTER[i] + 0.055;
    const right = FM_CENTER[i + 1] - 0.055;
    if (u <= FM_CENTER[i + 1]) {
      if (u <= left) return FM_STOPS[i];
      if (u >= right) return FM_STOPS[i + 1];
      const f = (u - left) / (right - left);
      const s = f * f * (3 - 2 * f);
      return FM_STOPS[i] * (1 - s) + FM_STOPS[i + 1] * s;
    }
  }
  return FM_STOPS[FM_STOPS.length - 1];
}

function fade(u: number, a: number, b: number): number {
  if (u <= a) return 0;
  if (u >= b) return 1;
  const x = (u - a) / (b - a);
  return x * x * (3 - 2 * x);
}

function lerpStops(stops: readonly number[], t: number): number {
  const n = stops.length;
  const u = Math.max(0, Math.min(1, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(u));
  const f = u - i;
  return stops[i] * (1 - f) + stops[i + 1] * f;
}

function percNoiseAmt(material: number): number {
  return lerpStops([0.14, 0.2, 0.1, 0.03, 0.07, 0.04], material);
}

function percTone(material: number): number {
  return lerpStops([0.22, 0.35, 0.4, 0.62, 0.75, 0.7], material);
}

interface Spectrum {
  r2: number;
  a2: number;
  r3: number;
  a3: number;
  shape: number;
  fm: number;
}

const KICK_CENTER = [0.08, 0.28, 0.5, 0.78, 0.96];
const SNARE_CENTER = [0.08, 0.28, 0.5, 0.75, 0.92];
const PERC_CENTER = [0.08, 0.24, 0.42, 0.58, 0.74, 0.92];

function shelfSpec(table: readonly number[], centers: readonly number[], t: number): Spectrum {
  const row = (index: number): Spectrum => {
    const o = index * 6;
    return {
      r2: table[o], a2: table[o + 1], r3: table[o + 2], a3: table[o + 3], shape: table[o + 4], fm: table[o + 5],
    };
  };
  const u = Math.max(0, Math.min(1, t));
  if (u <= centers[0]) return row(0);
  for (let i = 0; i < centers.length - 1; i++) {
    if (u > centers[i + 1]) continue;
    const left = centers[i] + 0.06;
    const right = centers[i + 1] - 0.06;
    if (right <= left || u <= left) return row(i);
    if (u >= right) return row(i + 1);
    const f = (u - left) / (right - left);
    const s = f * f * (3 - 2 * f);
    const a = row(i);
    const b = row(i + 1);
    const m = (x: number, y: number) => x * (1 - s) + y * s;
    return { r2: m(a.r2, b.r2), a2: m(a.a2, b.a2), r3: m(a.r3, b.r3), a3: m(a.a3, b.a3), shape: m(a.shape, b.shape), fm: m(a.fm, b.fm) };
  }
  return row(centers.length - 1);
}

const KICK_SPEC = [
  2, 0, 3, 0, 0, 0,
  1.59, 0.48, 2.2, 0.14, 0.1, 0,
  3, 0.34, 5, 0.16, 0.22, 0,
  3.4, 0.95, 5.2, 0.62, 0.08, 0,
  2, 0.28, 3.2, 0.2, 0.96, 0,
];

const SNARE_SPEC = [
  2, 0.02, 3, 0, 0, 0,
  2, 0.92, 4, 0.08, 0, 0,
  2.29, 0.58, 3.71, 0.36, 0.1, 0,
  2.76, 0.64, 5.4, 0.42, 0.12, 0.45,
  1.41, 0.3, 2, 0.18, 0.2, 1.7,
];

const PERC_SPEC = [
  1.7, 0.36, 2.4, 0.1, 0.05, 0,
  2.3, 0.52, 3.6, 0.3, 0.08, 0,
  1.48, 0.88, 2.2, 0.42, 0.04, 0,
  2, 0.48, 2.98, 0.58, 0.06, 0.35,
  2.71, 0.72, 4.2, 0.52, 0.1, 0.55,
  1, 0.12, 1, 0, 0.12, 2.5,
];

function wrapPhase(phase: number): number {
  if (phase < TWO_PI) return phase;
  return phase - TWO_PI * Math.floor(phase / TWO_PI);
}

function tonalBody(drum: DrumVoice, freq: number): { mid: number; side: number } {
  const spec = drum.lane === 0
    ? shelfSpec(KICK_SPEC, KICK_CENTER, drum.body)
    : drum.lane === 1
      ? shelfSpec(SNARE_SPEC, SNARE_CENTER, drum.body)
      : shelfSpec(PERC_SPEC, PERC_CENTER, drum.body);
  let a2 = spec.a2;
  let a3 = spec.a3;
  if (drum.lane === 1) {
    const pair = 0.4 + drum.tone * 0.95;
    const fall = Math.max(drum.env, 1e-4) ** 0.7;
    a2 *= pair * fall;
    a3 *= pair * (0.35 + drum.tone) * fall * fall;
  }
  let dull = 1;
  if (drum.damp > 0.001) {
    const e = Math.max(drum.env, 1e-4);
    dull = e ** (1 + drum.damp * 6);
    a2 *= dull;
    a3 *= dull * dull;
  }
  const inc = (TWO_PI * freq) / SAMPLE_RATE;
  let index = (drum.fm * 5 + spec.fm) * dull;
  let fmMix = index <= 0 ? 0 : Math.min(1, index / 0.8);
  if (drum.lane === 3) {
    const env = Math.max(drum.env, 1e-4);
    const held = drum.damp > 0.001 ? env ** (drum.damp * 1.5) : 1;
    const user = drum.fm ** 0.55 * 5.5;
    index = user * (0.15 + 0.85 * held) + spec.fm * dull;
    fmMix = index <= 0 ? 0 : Math.min(1, index / 0.65);
  }
  const ratio = spec.r3 * (1 - fmMix) + drum.ratio * fmMix;
  drum.phase0 = wrapPhase(drum.phase0 + inc);
  drum.phase1 = wrapPhase(drum.phase1 + inc * spec.r2);
  drum.phase2 = wrapPhase(drum.phase2 + inc * ratio);
  const p1 = Math.sin(drum.phase1);
  const p2 = Math.sin(drum.phase2);
  const sine = Math.sin(drum.phase0);
  const bent = Math.sin(drum.phase0 + p2 * index);
  let x = sine * (1 - fmMix) + bent * fmMix + p1 * a2 * (1 - fmMix * 0.45) + p2 * a3 * (1 - fmMix);
  if (drum.lane === 3) x += p2 * fmMix * 0.2;
  if (spec.shape > 0.001) {
    const shaped = Math.tanh(x * (1 + spec.shape * 7));
    x += (shaped - x) * spec.shape;
  }
  const gain = drum.lane === 0 ? 0.85 : drum.lane === 1 ? 0.55 : 0.6;
  return { mid: x * gain, side: 0 };
}

function hatBody(drum: DrumVoice, freq: number): { mid: number; side: number } {
  const m = Math.max(0, Math.min(1, drum.body));
  const ring = drum.ring;
  const lo = [1, 2.02, 2.97, 4.05];
  const hi = [1, 1.47, 2.31, 3.73];
  const gain = m <= 0.06 ? 0 : (m - 0.06) / 0.94;
  const inc = (TWO_PI * freq) / SAMPLE_RATE;
  const ratio = (i: number) => lo[i] * (1 - m) + hi[i] * m;
  drum.phase0 = wrapPhase(drum.phase0 + inc * ratio(0));
  drum.phase1 = wrapPhase(drum.phase1 + inc * ratio(1));
  drum.phase2 = wrapPhase(drum.phase2 + inc * ratio(2));
  drum.phase3 = wrapPhase(drum.phase3 + inc * ratio(3));
  const s0 = Math.sin(drum.phase0) * 0.9 * gain;
  const s1 = Math.sin(drum.phase1) * 0.72 * gain * (1 - ring * 0.35);
  const s2 = Math.sin(drum.phase2) * 0.5 * gain * (1 - ring * 0.6);
  const s3 = Math.sin(drum.phase3) * 0.36 * gain * (1 - ring * 0.8);
  return { mid: (s0 + s1 + s2 + s3) * 0.42, side: 0 };
}

function poleCoef(hz: number): number {
  return 1 - Math.exp((-TWO_PI * hz) / SAMPLE_RATE);
}

function noiseSample(engine: Engine, drum: DrumVoice): number {
  const white = rng(engine);
  if (drum.lane === 1) {
    const tone = Math.max(0, Math.min(1, drum.tone));
    const sounded = Math.max(40, drum.freq * 2 ** (drum.bend * drum.pitchEnv));
    const center = sounded * (4.5 * 4 ** tone);
    const low = Math.max(140, Math.min(5000, center * 0.5));
    const high = Math.min(14000, Math.max(low * 2, center * 2.4));
    drum.nlp += (white - drum.nlp) * poleCoef(high);
    drum.nhp += (drum.nlp - drum.nhp) * poleCoef(low);
    return (drum.nlp - drum.nhp) * drum.noise * (3.6 + tone * 2.2);
  }
  const tilt = Math.max(0, Math.min(1, drum.tone));
  drum.nlp += (white - drum.nlp) * (0.04 + tilt * 0.5);
  drum.nhp += (white - drum.nhp) * (0.03 + tilt * 0.45);
  const high = white - drum.nhp;
  return (drum.nlp * (1 - tilt) + high * tilt) * drum.noise;
}

function transientSample(engine: Engine, drum: DrumVoice): number {
  const u = drum.click;
  const env = drum.clickEnv;
  drum.clickEnv *= drum.clickK;
  const burst = rng(engine);
  if (u < 0.001 || env < 1e-5) return 0;
  if (drum.lane === 1) {
    const tickW = 1 - fade(u, 0.12, 0.62);
    const pulseW = fade(u, 0.08, 0.55);
    const crackHz = 900 * (7500 / 900) ** u;
    const coef = poleCoef(crackHz);
    drum.phase3 += (burst - drum.phase3) * coef;
    const crack = drum.phase3 * (1 - u * 0.7) + burst * (u * 0.7);
    const tickHz = 600 + u * 3400;
    drum.clickPhase = wrapPhase(drum.clickPhase + (TWO_PI * tickHz) / SAMPLE_RATE);
    const tick = Math.sin(drum.clickPhase);
    const sharp = env ** (1 + u * 0.8);
    const level = 0.75 + u * 0.45;
    return (tick * tickW * 0.8 + crack * pulseW * 2.6) * level * sharp;
  }
  if (drum.lane === 2) {
    const sharp = env ** (0.5 + u);
    return burst * u * 1.8 * sharp;
  }
  const tickW = 1 - fade(u, 0.12, 0.5);
  const pulseW = fade(u, 0.15, 0.45) * (1 - fade(u, 0.55, 0.9));
  const chirpW = fade(u, 0.4, 0.8);
  drum.clickPhase = wrapPhase(drum.clickPhase + (TWO_PI * (900 + 5200 * env)) / SAMPLE_RATE);
  const chirp = Math.sin(drum.clickPhase);
  const tick = Math.sin(drum.clickPhase * 0.45);
  return (tick * tickW + burst * env * env * pulseW + chirp * chirpW) * u * 1.15 * env;
}

function drumIndex(lane: LaneId): number {
  if (lane === "snare") return 1;
  if (lane === "hat") return 2;
  if (lane === "perc") return 3;
  return 0;
}

function rng(engine: Engine): number {
  engine.noise = (Math.imul(engine.noise, 1664525) + 1013904223) >>> 0;
  return engine.noise / 4294967296 * 2 - 1;
}

function emptyDrum(): DrumVoice {
  return {
    on: false, lane: 0, phase0: 0, phase1: 0, phase2: 0, phase3: 0, clickPhase: 0,
    env: 0, noiseEnv: 0, pitchEnv: 1, clickEnv: 0, age: 0, freq: 0,
    decay: 0.2, noiseDecay: 0.05, bendTime: 0.08, bend: 0, body: 0, noise: 0, tone: 0.3,
    click: 0, drive: 0, fm: 0, ratio: 1, ring: 0, pos: 0.5, damp: 0,
    cutoff: 0.5, resonance: 0, reverb: 0, delay: 0, nlp: 0, nhp: 0, flt: 0, band: 0, loop: 0,
    envK: 1, noiseK: 1, pitchK: 1, clickK: 1, gain: 0,
    haas: new Float32Array(HAAS_N), haasI: 0,
  };
}

function emptyNote(): NoteVoice {
  return {
    on: false, phase: [0, 0, 0], slave: [0, 0, 0], env: 0, tail: 0, age: 0, left: 0, freq: 0,
    wave: 0.36, bend: 0, sync: 0, fold: 0, drive: 0, wide: 0,
    glide: 0, pluck: 0, pluckK: 1, envAmt: 0, filterEnv: 0, target: 0, claim: 0,
    cutoff: 0.5, resonance: 0, reverb: 0, delay: 0, attack: 0, release: 0.4, gain: 0,
    low: 0, band: 0, lane: 0, pitch: 0, loop: 0, releaseK: 1,
    haas: new Float32Array(HAAS_N), haasI: 0,
  };
}
