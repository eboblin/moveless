import { modulated } from "./modulate.ts";
import { MOTIF_BANK_VERSION } from "./motif.ts";
import {
  DRUMS,
  LANES,
  SOUND,
  type ChordLane,
  type DrumId,
  type DrumLane,
  type EuclidGen,
  type LaneId,
  type Lanes,
  type PitchedLane,
  type Project,
  type GlobalSettings,
} from "./types.ts";

function euclid(length: number, hits: number, rotate = 0, velocity = 0.85): EuclidGen {
  return {
    length,
    hits,
    rotate,
    probability: 1,
    velocity: modulated(velocity),
  };
}

/**
 * Musical resting points per lane. Chords stay near mid — that set already
 * reads well; drums/bass/lead used to park every knob at 0.5 and sounded wrong.
 */
const SOUND_VALUE: Record<LaneId, Record<string, number>> = {
  kick: {
    pitch: 0.4,
    bend: 0.62,
    snap: 0.28,
    click: 0.2,
    decay: 0.28,
    noise: 0.7,
    drive: 0.1,
    tone: 0.3,
  },
  snare: {
    pitch: 0.48,
    body: 0.72,
    noise: 0.48,
    snap: 0.42,
    decay: 0.24,
    tail: 0.22,
    click: 0.38,
    drive: 0.08,
  },
  hat: {
    pitch: 0.55,
    click: 0.52,
    snap: 0.16,
    decay: 0.18,
    tone: 0.58,
    drive: 0.06,
    pan: 0.5,
    spread: 0.28,
  },
  perc: {
    pitch: 0.44,
    tone: 0.46,
    bend: 0.32,
    noise: 0.18,
    decay: 0.22,
    tail: 0.18,
    pan: 0.5,
    spread: 0.12,
  },
  bass: {
    shape: 0.16,
    detune: 0.5,
    fm: 0.05,
    noise: 0.02,
    cutoff: 0.48,
    resonance: 0.1,
    attack: 0.015,
    decay: 0.4,
  },
  lead: {
    shape: 0.38,
    detune: 0.5,
    fm: 0.08,
    noise: 0.03,
    cutoff: 0.7,
    resonance: 0.08,
    attack: 0.01,
    release: 0.3,
  },
  chords: {
    shape: 0.5,
    detune: 0.5,
    fm: 0.5,
    width: 0.5,
    cutoff: 0.5,
    resonance: 0.5,
    attack: 0.5,
    release: 0.5,
  },
};

function sound(lane: LaneId): Record<string, ReturnType<typeof modulated>> {
  const ids = SOUND[lane];
  const values = SOUND_VALUE[lane];
  const out: Record<string, ReturnType<typeof modulated>> = {};
  for (const id of ids) out[id] = modulated(values[id] ?? 0.5);
  return out;
}

const DRUM_PRIMARY: Record<DrumId, EuclidGen> = {
  kick: euclid(16, 4, 0, 1),
  snare: euclid(16, 2, 4, 1),
  hat: euclid(16, 8, 0, 0.75),
  perc: euclid(16, 3, 1, 0.7),
};

function drum(id: DrumId): DrumLane {
  return {
    gen1: { ...DRUM_PRIMARY[id], velocity: { ...DRUM_PRIMARY[id].velocity } },
    gen2: euclid(16, 0, 0, 0.55),
    ratchet: { count: modulated(0), rate: modulated(1 / 6) },
    sound: sound(id),
  };
}

function pitched(lane: "bass" | "lead", follow: number, hits: number, octaveBias: number): PitchedLane {
  return {
    gen1: euclid(16, hits, 0, 0.8),
    gen2: euclid(16, 0, 0, 0.55),
    follow,
    degree: modulated(0.5),
    range: modulated(octaveBias),
    length: modulated(lane === "bass" ? 0.55 : 0.35),
    repeat: modulated(0),
    step: modulated(0.5),
    sound: sound(lane),
  };
}

function chords(): ChordLane {
  return {
    change: modulated(0.35),
    length: modulated(0.8),
    motion: modulated(0.35),
    variation: modulated(0),
    mood: modulated(0),
    tension: modulated(0.15),
    play: {
      mode: 0,
      rate: 1,
      gate: 0.7,
      octaves: 1,
      spread: 0.25,
      flow: 0.5,
      strum: 0,
      direction: 0,
    },
    sound: sound("chords"),
  };
}

export function defaultGlobal(): GlobalSettings {
  return {
    tempo: 120,
    swing: 0,
    root: 0,
    scale: "minor",
    transpose: 0,
    bar: 4,
    phrase: 4,
    seed: 1,
  };
}

export function defaultLanes(): Lanes {
  const bass = pitched("bass", 1, 2, 0.45);
  const lead = pitched("lead", 0.65, 1, 0.55);
  return {
    kick: drum("kick"),
    snare: drum("snare"),
    hat: drum("hat"),
    perc: drum("perc"),
    bass,
    lead,
    chords: chords(),
  };
}

export function defaultProject(): Project {
  const mute = {} as Project["mute"];
  const lock = {} as Project["lock"];
  const mixer = { master: 0.8 } as Project["mixer"];
  for (const lane of LANES) {
    mute[lane] = false;
    lock[lane] = false;
    mixer[lane] = 0.75;
  }
  return {
    motifBankVersion: MOTIF_BANK_VERSION,
    nextSceneId: 1,
    journal: [],
    sets: [],
    activeSetId: null,
    mixer,
    global: defaultGlobal(),
    macros: {},
    bookmarks: [null, null, null, null],
    mute,
    lock,
    working: defaultLanes(),
    transition: "fast",
    wander: null,
    wanderPreviousTarget: null,
    wanderOriginTick: 0,
    activeSceneId: null,
    morph: null,
    clipboardSceneId: null,
    captureNonce: 0,
    captureIntensity: "medium",
  };
}

export function drumIds(): readonly DrumId[] {
  return DRUMS;
}
