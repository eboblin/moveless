import { hash01 } from "./hash.ts";
import { homeOctave, unitForOctave } from "./phrase.ts";
import { modulated } from "./modulate.ts";
import { MOTIF_BANK_VERSION } from "./motif.ts";
import {
  LANES,
  SOUND,
  type ChordLane,
  type DrumId,
  type DrumLane,
  type EuclidGen,
  type LaneFilter,
  type LaneId,
  type LaneSend,
  type Lanes,
  type PitchedLane,
  type Project,
  type GlobalSettings,
  type Space,
} from "./types.ts";

const CYCLE_CHOICES = [4, 8, 16] as const;

function homeCycle(key: string): number {
  return CYCLE_CHOICES[Math.floor(hash01("default-cycle", key) * CYCLE_CHOICES.length)] ?? 4;
}

function home(key: string, value: number) {
  return modulated(value, 0, homeCycle(key), 0);
}

function euclid(length: number, hits: number, rotate: number, velocity: number, cycleKey: string): EuclidGen {
  return {
    length,
    hits,
    rotate,
    probability: 1,
    velocity: home(cycleKey, velocity),
  };
}

/** Stable scatter: hits 2..4, rotate 0..15. Same lane and generator always land on the same pair. */
function scatteredGen(lane: string, which: 1 | 2, velocity: number): EuclidGen {
  const hits = 2 + Math.floor(hash01("default-gen", lane, which, "hits") * 3);
  const rotate = Math.floor(hash01("default-gen", lane, which, "rotate") * 16);
  return euclid(16, hits, rotate, velocity, `${lane}.gen${which}.velocity`);
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
    attack: 0.015,
    decay: 0.4,
  },
  lead: {
    shape: 0.38,
    detune: 0.5,
    fm: 0.08,
    noise: 0.03,
    attack: 0.01,
    release: 0.3,
  },
  chords: {
    shape: 0.5,
    detune: 0.5,
    fm: 0.5,
    width: 0.5,
    attack: 0,
    release: 0,
  },
};

function laneFilter(lane: string): LaneFilter {
  return {
    cutoff: home(`${lane}.filter.cutoff`, 0.5),
    resonance: home(`${lane}.filter.resonance`, 0),
  };
}

function laneSend(lane: string): LaneSend {
  return {
    reverb: home(`${lane}.send.reverb`, 0),
    delay: home(`${lane}.send.delay`, 0),
  };
}

function sound(lane: LaneId): Record<string, ReturnType<typeof modulated>> {
  const ids = SOUND[lane];
  const values = SOUND_VALUE[lane];
  const out: Record<string, ReturnType<typeof modulated>> = {};
  for (const id of ids) out[id] = home(`${lane}.${id}`, values[id] ?? 0.5);
  return out;
}

const DRUM_VELOCITY: Record<DrumId, number> = {
  kick: 1,
  snare: 1,
  hat: 0.75,
  perc: 0.7,
};

function drum(id: DrumId): DrumLane {
  return {
    gen1: scatteredGen(id, 1, DRUM_VELOCITY[id]),
    gen2: scatteredGen(id, 2, 0.55),
    ratchet: { count: home(`${id}.ratchet.count`, 0), rate: home(`${id}.ratchet.rate`, 0) },
    sound: sound(id),
    filter: laneFilter(id),
    send: laneSend(id),
  };
}

function pitched(lane: "bass" | "lead", follow: number): PitchedLane {
  return {
    gen1: scatteredGen(lane, 1, 0.8),
    gen2: scatteredGen(lane, 2, 0.55),
    follow,
    pitch: home(`${lane}.pitch`, 0.5),
    octave: home(`${lane}.octave`, unitForOctave(homeOctave(lane))),
    length: home(`${lane}.length`, lane === "bass" ? 0.55 : 0.35),
    repeat: home(`${lane}.repeat`, 0),
    step: home(`${lane}.step`, 0.5),
    sound: sound(lane),
    filter: laneFilter(lane),
    send: laneSend(lane),
  };
}

function chords(): ChordLane {
  return {
    start: 0,
    count: 4,
    length: 4,
    motion: 1,
    variation: 0,
    mood: 0,
    tension: 0.15,
    way: 3,
    tone: home("chords.tone", 0),
    octave: home("chords.octave", unitForOctave(4)),
    rate: home("chords.rate", 0),
    gate: home("chords.gate", 0.7),
    sound: sound("chords"),
    filter: laneFilter("chords"),
    send: laneSend("chords"),
  };
}

export function defaultSpace(): Space {
  return {
    reverb: {
      size: 0.45,
      decay: 0.55,
      damp: 0.4,
      diff: 0.7,
      pre: 0.08,
      width: 0.85,
      low: 0.25,
      level: 0.75,
    },
    delay: {
      // 0.4 is an eighth note when the bar is four beats.
      time: 0.4,
      feed: 0.4,
      hi: 0.65,
      lo: 0.12,
      width: 0.55,
      mod: 0.12,
      rate: 0.3,
      level: 0.7,
    },
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
  const bass = pitched("bass", 1);
  const lead = pitched("lead", 0.65);
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
  const mixer = { master: 1 } as Project["mixer"];
  for (const lane of LANES) {
    mute[lane] = false;
    lock[lane] = false;
    mixer[lane] = 1;
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
    space: defaultSpace(),
    transition: "fast",
    wander: null,
    wanderPreviousTarget: null,
    wanderOriginTick: 0,
    activeSceneId: null,
    morph: null,
    clipboardSceneId: null,
    captureNonce: 0,
    captureIntensity: "medium",
    captureScope: "group",
    captureDepth: "all",
  };
}
