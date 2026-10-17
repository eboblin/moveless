export const LANES = ["kick", "snare", "hat", "perc", "bass", "lead", "chords"] as const;
export type LaneId = (typeof LANES)[number];
export type DrumId = "kick" | "snare" | "hat" | "perc";
export type PitchedId = "bass" | "lead";
export type AuxId = "aux";
export type ContextId = LaneId | AuxId;

/** Step buttons: the seven lanes, then one section button. */
export const STEPS = [...LANES, "aux"] as const satisfies readonly ContextId[];

export function isLane(id: ContextId): id is LaneId {
  return (LANES as readonly string[]).includes(id);
}

export const DRUMS: readonly DrumId[] = ["kick", "snare", "hat", "perc"];
export const PITCHED: readonly PitchedId[] = ["bass", "lead"];

export const LANE_CODE: Record<LaneId | AuxId, string> = {
  kick: "KCK",
  snare: "SNR",
  hat: "HAT",
  perc: "PRC",
  bass: "BAS",
  lead: "LEA",
  chords: "CHD",
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

export const SPACE_REVERB = ["size", "decay", "damp", "diff", "pre", "width", "low", "level"] as const;
export const SPACE_DELAY = ["time", "feed", "hi", "lo", "width", "mod", "rate", "level"] as const;

export interface SpaceReverb {
  size: number;
  decay: number;
  damp: number;
  diff: number;
  pre: number;
  width: number;
  low: number;
  level: number;
}

export interface SpaceDelay {
  time: number;
  feed: number;
  hi: number;
  lo: number;
  width: number;
  mod: number;
  rate: number;
  level: number;
}

/** Shared reverb and delay. Part of the pattern, not a modulator. */
export interface Space {
  reverb: SpaceReverb;
  delay: SpaceDelay;
}

export const PROGRESSION_KEYS = ["start", "count", "length", "motion", "variation", "mood", "tension", "way"] as const;

/** Chord walk for the whole pattern. Not a lane and not morphed. */
export interface Progression {
  /** Starting scale degree. */
  start: number;
  /** How many chords fill the phrase. */
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
  ratchet: { count: Modulated; rate: Modulated };
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
  repeat: Modulated;
  step: Modulated;
  sound: Record<string, Modulated>;
  filter: LaneFilter;
  send: LaneSend;
}

export interface ChordLane {
  /** 0 is the root of the current chord, 1 is its top tone. */
  tone: Modulated;
  /** Absolute octave 0..9, same scale as bass and lead. */
  octave: Modulated;
  rate: Modulated;
  gate: Modulated;
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
}

export interface Scene {
  id: string;
  lanes: Lanes;
  /** Chord walk, recorded with the pattern. Heard as a whole, not blended. */
  progression: Progression;
  /** Reverb and delay knobs, recorded with the pattern. */
  space: Space;
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
export type WanderId = "fast" | "medium" | "slow" | "glacial";
/** Clear kills modulation; soft/medium/hard scale how often pattern/cycle/amount move. */
export type CaptureIntensity = "clear" | "soft" | "medium" | "hard";
export const CAPTURE_INTENSITIES: readonly CaptureIntensity[] = ["clear", "soft", "medium", "hard"];
/** Capture overlay: whole lane, the page's group, or only the page's knobs. */
export type CaptureScope = "lane" | "group" | "page";
export const CAPTURE_SCOPES: readonly CaptureScope[] = ["lane", "group", "page"];
/** `all` moves everything. `generators` only pattern/cycle/amount. `values` skips those three. */
export type CaptureDepth = "all" | "generators" | "values";
export const CAPTURE_DEPTHS: readonly CaptureDepth[] = ["all", "generators", "values"];

export const TRANSITIONS: readonly TransitionId[] = ["now", "fast", "medium", "slow"];
export const WANDERS: readonly WanderId[] = ["fast", "medium", "slow", "glacial"];
/** Menu button under the jog wheel. */
export const MENU_CC = 50;

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
  glacial: 32,
};

export interface PageRef {
  context: ContextId;
  page: number;
}

export interface MorphState {
  start: Lanes;
  startSpace: Space;
  targetId: string;
  originTick: number;
  durationTicks: number;
  punched: string[];
  /** 0 before originTick, then the morph clock. The heard phrase reads this. */
  t: number;
}

export interface SceneSet {
  id: string;
  name: string;
  sceneIds: string[];
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
  bookmarks: (PageRef | null)[];
  mute: Record<LaneId, boolean>;
  lock: Record<LaneId, boolean>;
  working: Lanes;
  /** Heard chord walk. Record copies this into the scene. A morph keeps it until landing. */
  progression: Progression;
  /** Heard reverb and delay. Record copies this into the scene. */
  space: Space;
  transition: TransitionId;
  wander: WanderId | null;
  wanderPreviousTarget: string | null;
  wanderOriginTick: number;
  /** Last scene that fully landed; source pad while a morph is running. */
  activeSceneId: string | null;
  morph: MorphState | null;
  clipboardSceneId: string | null;
  captureNonce: number;
  /** Capture overlay + plain Capture: clear modulation or soft/medium/hard reroll. */
  captureIntensity: CaptureIntensity;
  /** What a bare Capture release rerolls. Survives the hold. */
  captureScope: CaptureScope;
  /** Whether that reroll also moves numeric values. */
  captureDepth: CaptureDepth;
}

export interface HarmonicEvent {
  startTick: number;
  lengthTicks: number;
  root: number;
  quality: number;
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

export const SOUND: Record<LaneId, readonly string[]> = {
  kick: ["pitch", "bend", "snap", "click", "decay", "noise", "drive", "tone"],
  snare: ["pitch", "body", "noise", "snap", "decay", "tail", "click", "drive"],
  hat: ["pitch", "click", "snap", "decay", "tone", "drive", "pan", "spread"],
  perc: ["pitch", "tone", "bend", "noise", "decay", "tail", "pan", "spread"],
  bass: ["wave", "bend", "sync", "fold", "drive", "wide", "attack", "release"],
  lead: ["wave", "bend", "sync", "fold", "drive", "wide", "attack", "release"],
  chords: ["wave", "bend", "sync", "fold", "drive", "wide", "attack", "release"],
};

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
