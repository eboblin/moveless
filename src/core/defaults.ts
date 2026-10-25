import { defaultDeck } from "./deck.ts";
import { homeOctave, unitForOctave } from "./phrase.ts";
import { modulated } from "./modulate.ts";
import { MOTIF_BANK_VERSION } from "./motif.ts";
import { SOUND } from "./pages.ts";
import {
  LANES,
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
  type Progression,
  type Bus,
  type Fx,
} from "./types.ts";

export { defaultDeck };

/** Pattern, cycle and amount sit at rest. Cycle 1 is the bottom of the knob; amount 0 keeps it silent. */
function home(value: number) {
  return modulated(value);
}

/** Hits and rotate sit at zero, so a fresh pattern is silent and unshifted. */
function euclid(velocity: number): EuclidGen {
  return {
    length: 16,
    hits: 0,
    rotate: 0,
    probability: 1,
    velocity: home(velocity),
  };
}

/**
 * Musical resting points per lane. Chords stay near mid — that set already
 * reads well; drums/bass/lead used to park every knob at 0.5 and sounded wrong.
 */
const SOUND_VALUE: Record<LaneId, Record<string, number>> = {
  kick: {
    pitch: 0.12,
    decay: 0.1,
    bend: 0.77,
    bendTime: 0.44,
    body: 0.18,
    click: 0.24,
    noise: 0.05,
    drive: 0.01,
  },
  snare: {
    pitch: 0.03,
    body: 0.38,
    bodyDecay: 0.1,
    noise: 0.17,
    noiseDecay: 0.19,
    snap: 0.08,
    tone: 0.28,
    drive: 0.12,
  },
  hat: {
    pitch: 0,
    metal: 0,
    noise: 0.09,
    color: 0,
    decay: 0.19,
    attack: 0.35,
    ring: 0.32,
    pos: 0.5,
  },
  perc: {
    pitch: 0.23,
    material: 0.6,
    decay: 0.14,
    bend: 0.36,
    fm: 0,
    fmRatio: 0.29,
    attack: 0.16,
    damp: 0.11,
  },
  bass: {
    wave: 0.28,
    bend: 0,
    glide: 0,
    sync: 0,
    fold: 0,
    drive: 0,
    wide: 0,
    attack: 0.15,
    release: 0.09,
    pluck: 0,
    env: 0,
  },
  lead: {
    wave: 0.84,
    bend: 0,
    glide: 0,
    sync: 0,
    fold: 0,
    drive: 0,
    wide: 0,
    attack: 0.23,
    release: 0.01,
    pluck: 0,
    env: 0,
  },
  chords: {
    wave: 0.24,
    bend: 0.04,
    glide: 0,
    sync: 0,
    fold: 0,
    drive: 0.06,
    wide: 0.4,
    attack: 0,
    release: 0,
    pluck: 0,
    env: 0,
  },
};

function laneFilter(): LaneFilter {
  return {
    cutoff: home(0.5),
    resonance: home(0),
  };
}

function laneSend(): LaneSend {
  return {
    reverb: home(0),
    delay: home(0),
  };
}

function sound(lane: LaneId): Record<string, ReturnType<typeof modulated>> {
  const ids = SOUND[lane];
  const values = SOUND_VALUE[lane];
  const out: Record<string, ReturnType<typeof modulated>> = {};
  for (const id of ids) out[id] = home(values[id] ?? 0.5);
  // Bend left the melody page. Keeping the key lets an old scene still warp the wave.
  if (lane === "bass" || lane === "lead" || lane === "chords") out.bend = home(SOUND_VALUE[lane].bend ?? 0);
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
    gen1: euclid(DRUM_VELOCITY[id]),
    gen2: euclid(0.55),
    ratchet: { count: home(0), rate: home(0) },
    sound: sound(id),
    filter: laneFilter(),
    send: laneSend(),
  };
}

function pitched(lane: "bass" | "lead"): PitchedLane {
  const bass = lane === "bass";
  return {
    gen1: euclid(bass ? 0.8 : 0.4),
    gen2: euclid(bass ? 0.3 : 0.55),
    follow: 1,
    pitch: home(0.5),
    octave: home(unitForOctave(homeOctave(lane))),
    length: home(bass ? 0.04 : 0.1),
    repeat: home(0),
    step: home(0),
    sound: sound(lane),
    filter: laneFilter(),
    send: laneSend(),
  };
}

export function defaultProgression(): Progression {
  return {
    start: 0,
    count: 4,
    length: 4,
    motion: 1,
    variation: 0,
    mood: 0,
    tension: 0.15,
    way: 3,
  };
}

function chords(): ChordLane {
  return {
    // Hits stay at zero with the other generators. Size 1 fills the bar once a hit is placed.
    gen1: euclid(0.85),
    tone: home(0),
    octave: home(unitForOctave(4)),
    // First step above a block: one root note per bar, about a sixteenth long.
    rate: home(0.01),
    gate: home(0.06),
    size: home(1),
    velocity: home(0.85),
    probability: home(1),
    sound: sound("chords"),
    filter: laneFilter(),
    send: laneSend(),
  };
}

export function defaultFx(): Fx {
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
  const bass = pitched("bass");
  const lead = pitched("lead");
  return {
    kick: drum("kick"),
    snare: drum("snare"),
    hat: drum("hat"),
    perc: drum("perc"),
    bass,
    lead,
    chords: chords(),
    fx: defaultFx(),
  };
}

export function defaultBus(): Bus {
  return { glue: 0, pump: 0, wide: 0, tilt: 0 };
}

export function defaultProject(): Project {
  const mute = {} as Project["mute"];
  const solo = {} as Project["solo"];
  const lock = {} as Project["lock"];
  const mixer = { master: 1 } as Project["mixer"];
  for (const lane of LANES) {
    mute[lane] = false;
    solo[lane] = false;
    lock[lane] = false;
    mixer[lane] = 1;
  }
  mute.fx = false;
  lock.fx = false;
  return {
    motifBankVersion: MOTIF_BANK_VERSION,
    nextSceneId: 1,
    journal: [],
    sets: [],
    activeSetId: null,
    mixer,
    global: defaultGlobal(),
    macros: {},
    bus: defaultBus(),
    deck: defaultDeck(),
    bookmarks: [null, null, null, null],
    mute,
    solo,
    lock,
    working: defaultLanes(),
    progression: defaultProgression(),
    transition: "fast",
    wander: null,
    wanderPreviousTarget: null,
    wanderOriginTick: 0,
    activeSceneId: null,
    morph: null,
    clipboardSceneIds: [],
    randomizeNonce: 0,
    randomizeIntensity: "medium",
    randomizeScope: "group",
    randomizeDepth: "all",
  };
}
