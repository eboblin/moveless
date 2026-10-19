import type { DrumId, LaneId } from "../core/types.ts";

/** Values are 0..1 semantic units. Engine ids stay inside this file. */
export interface EngineParam {
  id: string;
  value: number;
}

/**
 * Drum chain keys (GM pad ids kept for map stability).
 * Kick pad 1, snare pad 3, closed hat pad 7, perc pad 12 (low-mid tom).
 * Our voice reads every suffix below. Hat pos is the only drum pan.
 */
const VOICE: Record<DrumId, string> = {
  kick: "v01",
  snare: "v03",
  hat: "v07",
  perc: "v12",
};

const DRUM_SUFFIX: Record<DrumId, Record<string, string>> = {
  kick: {
    pitch: "freq",
    decay: "decay",
    bend: "pbend",
    bendTime: "btime",
    body: "body",
    click: "click",
    noise: "noise",
    drive: "dist",
  },
  snare: {
    pitch: "freq",
    body: "body",
    bodyDecay: "bdcy",
    noise: "noise",
    noiseDecay: "ndcy",
    snap: "snap",
    tone: "tone",
    drive: "dist",
  },
  hat: {
    pitch: "freq",
    metal: "metal",
    noise: "noise",
    color: "color",
    decay: "decay",
    attack: "atk",
    ring: "ring",
    pos: "pos",
  },
  perc: {
    pitch: "freq",
    material: "mat",
    decay: "decay",
    bend: "pbend",
    fm: "fm",
    fmRatio: "ratio",
    attack: "atk",
    damp: "damp",
  },
};

/**
 * Bass, lead and chords share one wavetable. Cutoff and resonance are the lane filter, not sound.
 * `decay` still reaches the voice as a release alias for older blocks.
 */
const MELODY: Record<string, string> = {
  wave: "wave",
  bend: "bend",
  sync: "sync",
  fold: "fold",
  drive: "drive",
  wide: "wide",
  attack: "attack",
  release: "release",
};

export function mapSound(lane: LaneId, sound: Record<string, number>): EngineParam[] {
  if (lane === "bass" || lane === "lead" || lane === "chords") {
    const table = MELODY;
    return Object.keys(sound).sort().map((id) => ({ id: table[id] ?? id, value: clamp(sound[id] ?? 0) }));
  }
  const voice = VOICE[lane];
  const table = DRUM_SUFFIX[lane];
  return Object.keys(sound).sort().map((id) => ({
    id: `${voice}_${table[id] ?? id}`,
    value: clamp(sound[id] ?? 0),
  }));
}

/** Lane filter. Plain ids so drums do not pick up a voice prefix. */
export function mapFilter(filter: { cutoff: number; resonance: number }): EngineParam[] {
  return [
    { id: "cutoff", value: clamp(filter.cutoff) },
    { id: "resonance", value: clamp(filter.resonance) },
  ];
}

/** Shared-effect sends. Plain ids, same on every lane. */
export function mapSend(send: { reverb: number; delay: number }): EngineParam[] {
  return [
    { id: "reverb", value: clamp(send.reverb) },
    { id: "delay", value: clamp(send.delay) },
  ];
}

export function mapKick(sound: Record<string, number>): EngineParam[] {
  return mapSound("kick", sound);
}

/** True when this semantic id has an engine name in the lane's table. */
export function hasSoundMap(lane: LaneId, id: string): boolean {
  if (lane === "bass" || lane === "lead" || lane === "chords") return id in MELODY;
  return id in DRUM_SUFFIX[lane];
}

function clamp(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
