export const LANES = ["kick", "snare", "hat", "perc", "bass", "lead", "chords"] as const;
export type LaneId = (typeof LANES)[number];
export type DrumId = "kick" | "snare" | "hat" | "perc";
export type PitchedId = "bass" | "lead";
export type AuxId = "mix" | "global";
export type ContextId = LaneId | AuxId;

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
  mix: "MIX",
  global: "GLB",
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

export interface DrumLane {
  gen1: EuclidGen;
  gen2: EuclidGen;
  ratchet: { count: Modulated; rate: Modulated };
  sound: Record<string, Modulated>;
}

export interface PitchedLane {
  gen1: EuclidGen;
  gen2: EuclidGen;
  follow: number;
  degree: Modulated;
  range: Modulated;
  length: Modulated;
  repeat: Modulated;
  step: Modulated;
  sound: Record<string, Modulated>;
}

export interface ChordPlay {
  mode: number;
  rate: number;
  gate: number;
  octaves: number;
  spread: number;
  flow: number;
  strum: number;
  direction: number;
}

export interface ChordLane {
  change: Modulated;
  length: Modulated;
  motion: Modulated;
  variation: Modulated;
  mood: Modulated;
  tension: Modulated;
  play: ChordPlay;
  sound: Record<string, Modulated>;
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
  targetId: string;
  originTick: number;
  durationTicks: number;
  punched: string[];
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
}

export interface Phrase {
  lanes: Record<LaneId, TimedEvent[]>;
  harmony: HarmonicEvent[];
  steps: Record<LaneId, number>;
}

export const SET_CAPACITY = 32;

export const SOUND: Record<LaneId, readonly string[]> = {
  kick: ["pitch", "boom", "snap", "click", "decay", "punch", "drive", "tone"],
  snare: ["pitch", "body", "noise", "snap", "decay", "ring", "crisp", "drive"],
  hat: ["pitch", "metal", "attack", "decay", "bright", "grit", "pan", "spread"],
  perc: ["pitch", "tone", "ping", "noise", "decay", "ring", "pan", "spread"],
  bass: ["shape", "detune", "fm", "noise", "cutoff", "resonance", "attack", "decay"],
  lead: ["shape", "detune", "fm", "noise", "cutoff", "resonance", "attack", "release"],
  chords: ["shape", "detune", "fm", "width", "cutoff", "resonance", "attack", "release"],
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
