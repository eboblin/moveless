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

function sound(ids: readonly string[], centre = 0.5): Record<string, ReturnType<typeof modulated>> {
  const out: Record<string, ReturnType<typeof modulated>> = {};
  for (const id of ids) out[id] = modulated(centre);
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
    sound: sound(SOUND[id]),
  };
}

function pitched(follow: number, hits: number, octaveBias: number): PitchedLane {
  return {
    gen1: euclid(16, hits, 0, 0.8),
    gen2: euclid(16, 0, 0, 0.55),
    follow,
    degree: modulated(0.5),
    range: modulated(octaveBias),
    length: modulated(0.45),
    repeat: modulated(0),
    step: modulated(0.5),
    sound: sound(SOUND.bass),
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
    sound: sound(SOUND.chords),
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
  const bass = pitched(1, 2, 0.45);
  bass.sound = sound(SOUND.bass);
  const lead = pitched(0.65, 1, 0.55);
  lead.sound = sound(SOUND.lead);
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
    morph: null,
    clipboardSceneId: null,
    captureNonce: 0,
  };
}

export function drumIds(): readonly DrumId[] {
  return DRUMS;
}
