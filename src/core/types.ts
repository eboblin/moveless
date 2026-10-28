import type { DeckKnobs } from "./deck.ts";

export const LANES = ["kick", "snare", "hat", "perc", "bass", "lead", "chords"] as const;
export type LaneId = (typeof LANES)[number];

/** Shared effects. A pattern lane, not a voice. Reverb and delay now; more can follow. */
export const FX_LANE = "fx" as const;
export type FxLaneId = typeof FX_LANE;
export type PatternId = LaneId | FxLaneId;
export const PATTERN_LANES = [...LANES, FX_LANE] as const satisfies readonly PatternId[];

export type DrumId = "kick" | "snare" | "hat" | "perc";
export type PitchedId = "bass" | "lead";
export type AuxId = "aux";
export type ContextId = PatternId | AuxId;

/** Contexts that have pages. Button index is {@link contextAtStep}: aux is the last of 16. */
export const STEPS = [...PATTERN_LANES, "aux"] as const satisfies readonly ContextId[];

/** Hardware step buttons. Voices and fx pack to the left. Aux is the rightmost. */
export const STEP_COUNT = 16;

export function contextAtStep(index: number): ContextId | null {
  if (index === STEP_COUNT - 1) return "aux";
  return PATTERN_LANES[index] ?? null;
}

export function isLane(id: ContextId): id is PatternId {
  return (PATTERN_LANES as readonly string[]).includes(id);
}

export function isVoice(id: ContextId): id is LaneId {
  return (LANES as readonly string[]).includes(id);
}

export const DRUMS: readonly DrumId[] = ["kick", "snare", "hat", "perc"];
export const PITCHED: readonly PitchedId[] = ["bass", "lead"];

export const LANE_CODE: Record<ContextId, string> = {
  kick: "KCK",
  snare: "SNR",
  hat: "HAT",
  perc: "PRC",
  bass: "BAS",
  lead: "LEA",
  chords: "CHD",
  fx: "FX",
  aux: "AUX",
};

export type ModPatternId = number;

export interface Modulated {
  value: number;
  pattern: ModPatternId;
  cycle: number;
  amount: number;
}

/** One Euclidean voice. `length` 0 turns it off. */
export interface EuclidGen {
  length: number;
  hits: number;
  rotate: number;
  /** 1 = keep every euclid hit, 0 = silence this generator. */
  probability: number;
  velocity: Modulated;
}

/** One high-pass / low-pass on the lane. Cutoff 0.5 leaves the signal alone. */
export interface LaneFilter {
  cutoff: Modulated;
  resonance: Modulated;
}

/** Sends into the shared reverb and delay. Home is dry. */
export interface LaneSend {
  reverb: Modulated;
  delay: Modulated;
}

export const FX_REVERB = ["size", "decay", "air", "spin", "shim", "level"] as const;
export const FX_DELAY = ["time", "feed", "tone", "duck", "ping", "taps", "wow", "level"] as const;

/** Plate. SIZE is the room, DECAY is the tail in time, AIR is brightness, SPIN is drift, SHIM lifts the tail an octave, LEVEL is the return. */
export interface FxReverb {
  size: number;
  decay: number;
  air: number;
  spin: number;
  shim: number;
  level: number;
}

/** TIME is the repeat, FEED how many, TONE the color, DUCK the dip under the hit, PING the bounce, TAPS the extra hits, WOW the tape drift, LEVEL the return. */
export interface FxDelay {
  time: number;
  feed: number;
  tone: number;
  duck: number;
  ping: number;
  taps: number;
  wow: number;
  level: number;
}

/**
 * Shared effects on the fx lane.
 * Recorded, locked, captured and morphed with the voices.
 * Knobs are plain values, not modulators.
 */
export interface Fx {
  reverb: FxReverb;
  delay: FxDelay;
}

export const PROGRESSION_KEYS = ["start", "count", "length", "motion", "variation", "mood", "tension", "way"] as const;

/** Chord walk for the whole pattern. Not a lane and not morphed. */
export interface Progression {
  /** Starting scale degree. */
  start: number;
  /** How many chords fill the phrase. 0 listens to external MIDI instead of walking. */
  count: number;
  /** Base harmonic unit: 0 sixteenth, 1 eighth, 2 beat, 3 half bar, 4 bar. */
  length: number;
  /** Scale steps between chords. */
  motion: number;
  /** Pitch jitter and how many chords become passing. */
  variation: number;
  mood: number;
  tension: number;
  /** 0 up, 1 down, 2 alternate, 3 random from the seed. */
  way: number;
}

export interface DrumLane {
  gen1: EuclidGen;
  gen2: EuclidGen;
  ratchet: { count: Modulated; rate: Modulated; fade: Modulated; tone: Modulated };
  sound: Record<string, Modulated>;
  filter: LaneFilter;
  send: LaneSend;
}

export interface PitchedLane {
  gen1: EuclidGen;
  gen2: EuclidGen;
  follow: number;
  pitch: Modulated;
  octave: Modulated;
  length: Modulated;
  /** Notes gen2 fits inside this note. 0 is one note. Gen1 ignores it. */
  repeat: Modulated;
  /** Scale degrees the run travels. 0.5 is none. Read once, on the source step. */
  step: Modulated;
  sound: Record<string, Modulated>;
  filter: LaneFilter;
  send: LaneSend;
}

export interface ChordLane {
  /** Coarse steps. The gap until the next hit is the hole a slice sits in. */
  gen1: EuclidGen;
  /** 0 is the root of the current chord, 1 is its top tone. */
  tone: Modulated;
  /** Absolute octave 0..9, same scale as bass and lead. */
  octave: Modulated;
  rate: Modulated;
  gate: Modulated;
  /** Fraction of the hole that sounds. 0 is one sixteenth, 1 is the whole hole. */
  size: Modulated;
  /** Loudness of each chord note. */
  velocity: Modulated;
  /**
   * Second gate after the euclidean probability.
   * A block rolls once for the whole hit. A pulse rolls each note on its own.
   */
  probability: Modulated;
  sound: Record<string, Modulated>;
  filter: LaneFilter;
  send: LaneSend;
}

export interface Lanes {
  kick: DrumLane;
  snare: DrumLane;
  hat: DrumLane;
  perc: DrumLane;
  bass: PitchedLane;
  lead: PitchedLane;
  chords: ChordLane;
  /** Effects. Part of the pattern, same as the voices. */
  fx: Fx;
}

export interface Scene {
  id: string;
  lanes: Lanes;
  /** Move pad color, assigned once when the scene is recorded. */
  color?: number;
}

export type ScaleId = "minor" | "major" | "dorian" | "mixolydian";

export const SCALES: Record<ScaleId, readonly number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

export const SCALE_IDS: readonly ScaleId[] = ["minor", "major", "dorian", "mixolydian"];

export interface GlobalSettings {
  tempo: number;
  swing: number;
  root: number;
  scale: ScaleId;
  transpose: number;
  bar: number;
  phrase: number;
  seed: number;
}

export type TransitionId = "now" | "fast" | "medium" | "slow";
export type WanderId = "fast" | "medium" | "slow";
/** Clear restores the factory values in scope. Soft/medium/hard step off the current value toward that factory. */
export type RandomizeIntensity = "clear" | "soft" | "medium" | "hard";
export const RANDOMIZE_INTENSITIES: readonly RandomizeIntensity[] = ["clear", "soft", "medium", "hard"];
/** Randomize overlay: whole lane, the page's group, or only the page's knobs. */
export type RandomizeScope = "lane" | "group" | "page";
export const RANDOMIZE_SCOPES: readonly RandomizeScope[] = ["lane", "group", "page"];
/** `all` moves everything. `generators` only pattern/cycle/amount of a VPCA. `values` is every other knob, including plain ones. */
export type RandomizeDepth = "all" | "generators" | "values";
export const RANDOMIZE_DEPTHS: readonly RandomizeDepth[] = ["all", "generators", "values"];

export const TRANSITIONS: readonly TransitionId[] = ["now", "fast", "medium", "slow"];
export const WANDERS: readonly WanderId[] = ["fast", "medium", "slow"];
/** Menu button under the jog wheel. */
export const MENU_CC = 50;
/** Jog wheel click. Latches the randomize pads. */
export const JOG_CLICK_CC = 3;
/** Transport play. The button LED has one color: bright while running, dark when stopped. */
export const PLAY_CC = 85;
/** Large circle beside Play. Press writes a new scene. */
export const RECORD_CC = 86;
/**
 * Sample. White button, bright while the transition/wander row is held or latched.
 * It does not open DJ FX and does not write a scene.
 */
export const SAMPLE_CC = 118;
/** Mixer. White button, bright while the mixer is held or latched. */
export const MUTE_CC = 88;
/** DJ FX. White button, bright while the deck is held or latched. */
export const CAPTURE_CC = 52;
/** Loop. Runs one randomize pass with the stored depth, scope and intensity. */
export const LOOP_CC = 58;
/** White up/down buttons. Journal pages or sets, bright only when that neighbor exists. */
export const UP_CC = 55;
export const DOWN_CC = 54;

export const TRANSITION_BARS: Record<TransitionId, number> = {
  now: 0,
  fast: 1,
  medium: 4,
  slow: 8,
};

export const WANDER_BARS: Record<WanderId, number> = {
  fast: 2,
  medium: 8,
  slow: 16,
};

export interface PageRef {
  context: ContextId;
  page: number;
}

export interface MorphState {
  start: Lanes;
  targetId: string;
  originTick: number;
  durationTicks: number;
  punched: string[];
  /** Null moves every unlocked lane. A list is the wander step's subset. */
  lanes: PatternId[] | null;
  /** Progress stored when the lanes last moved. Pad lamps read the clock via morphProgress. */
  t: number;
}

export interface SceneSet {
  id: string;
  name: string;
  sceneIds: string[];
}

/** Final mix on the aux button. Zero on a knob leaves the sum alone. Not part of a scene. */
export interface Bus {
  /** Bus compressor. 0 is a wire, 1 glues the sum. */
  glue: number;
  /** Kick ducks bass and chords. 0 leaves them alone. */
  pump: number;
  /** Opens the image by role. 0 leaves the existing picture. */
  wide: number;
  /** Darker below zero, brighter above. 0 is a wire. */
  tilt: number;
}

export interface Project {
  motifBankVersion: number;
  nextSceneId: number;
  journal: Scene[];
  sets: SceneSet[];
  activeSetId: string | null;
  mixer: Record<LaneId | "master", number>;
  global: GlobalSettings;
  macros: Record<string, number>;
  /** Heard after the voices and the fx returns. Record does not bake it. */
  bus: Bus;
  /** Deck screen knobs. Not part of a scene. */
  deck: DeckKnobs;
  bookmarks: (PageRef | null)[];
  /** Voices and the fx lane. Mute on fx silences the wet returns. */
  mute: Record<PatternId, boolean>;
  /** Additive solo. While any voice is soloed, only soloed unmuted voices are heard. Fx stays up. */
  solo: Record<LaneId, boolean>;
  lock: Record<PatternId, boolean>;
  working: Lanes;
  /** Heard chord walk. Record copies this into the scene. A morph keeps it until landing. */
  progression: Progression;
  transition: TransitionId;
  wander: WanderId | null;
  wanderPreviousTarget: string | null;
  /** Hold before the next wander step. A running morph moves this to its landing tick. */
  wanderOriginTick: number;
  /** Last scene that fully landed; source pad while a morph is running. */
  activeSceneId: string | null;
  morph: MorphState | null;
  /** Scenes marked for insertion into a set, in the order they were picked. */
  clipboardSceneIds: string[];
  randomizeNonce: number;
  /** Clear restores the factory values. Soft, medium and hard step toward that factory. */
  randomizeIntensity: RandomizeIntensity;
  /** What Loop rerolls: the whole lane, the page's group, or only the page. */
  randomizeScope: RandomizeScope;
  /** Whether that reroll moves generators, values, or both. */
  randomizeDepth: RandomizeDepth;
}

export interface HarmonicEvent {
  startTick: number;
  lengthTicks: number;
  root: number;
  quality: number;
  /** Pitch classes of an external chord, root first. The quality stack is not used. */
  pcs?: readonly number[];
}

export interface TimedEvent {
  lane: LaneId;
  tick: number;
  sample: number;
  sampleOffset: number;
  note: number;
  velocity: number;
  lengthTicks: number;
  step: number;
  sound: Record<string, number>;
  filter: { cutoff: number; resonance: number };
  send: { reverb: number; delay: number };
}

export interface Phrase {
  lanes: Record<LaneId, TimedEvent[]>;
  harmony: HarmonicEvent[];
  steps: Record<LaneId, number>;
}

export const SET_CAPACITY = 32;

export const QUALITY_NAMES = ["maj", "min", "sus2", "sus4", "7", "m7", "dim", "aug"] as const;

/** Semitone stacks from the chord root pitch class. */
export const QUALITY_SEMITONES: readonly (readonly number[])[] = [
  [0, 4, 7],
  [0, 3, 7],
  [0, 2, 7],
  [0, 5, 7],
  [0, 4, 7, 10],
  [0, 3, 7, 10],
  [0, 3, 6],
  [0, 4, 8],
];

export const DRUM_NOTE: Record<DrumId, number> = {
  kick: 36,
  snare: 38,
  hat: 42,
  perc: 47,
};

export function isDrum(lane: LaneId): lane is DrumId {
  return lane === "kick" || lane === "snare" || lane === "hat" || lane === "perc";
}

export function isPitched(lane: LaneId): lane is PitchedId {
  return lane === "bass" || lane === "lead";
}

export type LaneFamily = "drum" | "pitched" | "chords";

/** Which page list a lane uses. Drums share one list shape; sound ids still differ. */
export function laneFamily(lane: LaneId): LaneFamily {
  if (lane === "chords") return "chords";
  if (isPitched(lane)) return "pitched";
  return "drum";
}
