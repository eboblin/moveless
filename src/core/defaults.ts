import { modulated } from "./modulate.ts";
import { MOTIF_BANK_VERSION } from "./motif.ts";
import {
  DRUMS,
  LANES,
  SOUND,
  type ChordLane,
  type DrumId,
  type DrumLane,
  type EventGen,
  type EventPart,
  type Form,
  type GlobalSettings,
  type Lanes,
  type PitchedLane,
  type Project,
} from "./types.ts";

function gen(level: number, cycle: number, offset: number): EventGen {
  return { level, cycle, offset };
}

function part(g1: EventGen, g2: EventGen): EventPart {
  return { g1, g2 };
}

function form(follow: number): Form {
  return {
    length: 4,
    abSplit: 0.75,
    repeats: 1,
    varEvery: 4,
    varDiv: 16,
    varCount: 1,
    varAmount: 0,
    follow,
  };
}

function sound(ids: readonly string[], centre = 0.5): Record<string, ReturnType<typeof modulated>> {
  const out: Record<string, ReturnType<typeof modulated>> = {};
  for (const id of ids) out[id] = modulated(centre);
  return out;
}

const DRUM_GEN: Record<DrumId, EventGen> = {
  kick: gen(1, 4, 0),
  snare: gen(1, 8, 4),
  hat: gen(1, 2, 0),
  perc: gen(0.55, 6, 1),
};

function drum(id: DrumId, follow = 0): DrumLane {
  const primary = DRUM_GEN[id];
  const second = gen(0, 7, 5);
  return {
    events: {
      a: part(primary, second),
      b: part({ ...primary }, { ...second }),
    },
    form: form(follow),
    ratchet: { count: modulated(0), rate: modulated(1 / 6) },
    sound: sound(SOUND[id]),
  };
}

function pitched(follow: number, level: number, cycle: number, octaveBias: number): PitchedLane {
  const primary = gen(level, cycle, 0);
  const second = gen(0, 5, 2);
  return {
    events: {
      a: part(primary, second),
      b: part({ ...primary }, { ...second }),
    },
    form: form(follow),
    degree: modulated(0.5),
    range: modulated(octaveBias),
    length: modulated(0.45),
    velocity: modulated(0.8),
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
  const bass = pitched(1, 1, 8, 0.45);
  bass.sound = sound(SOUND.bass);
  const lead = pitched(0.65, 0.7, 16, 0.55);
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
