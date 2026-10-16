export const PPQN = 192;
export const SAMPLE_RATE = 44100;
export const FRAMES_PER_BLOCK = 128;
export const SIXTEENTH_TICKS = PPQN / 4;

export interface Rate {
  id: string;
  ticks: number;
}

/** 1/64 and triplet sixteenths are integers at 192 PPQN. Ratchet uses this table. */
export const RATES: readonly Rate[] = [
  { id: "1/8", ticks: 96 },
  { id: "1/16", ticks: 48 },
  { id: "1/16T", ticks: 32 },
  { id: "1/32", ticks: 24 },
  { id: "1/32T", ticks: 16 },
  { id: "1/64", ticks: 12 },
];

/** Chord arp. 0 on the knob is a block; the first step above that is a whole note. */
export const CHORD_RATES: readonly Rate[] = [
  { id: "1/1", ticks: PPQN * 4 },
  { id: "1/2", ticks: PPQN * 2 },
  { id: "1/4", ticks: PPQN },
  ...RATES,
];

export function ticksPerBar(beatsPerBar: number): number {
  return Math.max(1, Math.round(beatsPerBar)) * PPQN;
}

export function sixteenthSteps(bars: number, beatsPerBar: number): number {
  return Math.max(1, Math.round(bars)) * Math.max(1, Math.round(beatsPerBar)) * 4;
}

/** Swing 0 is straight. Swing 1 delays odd sixteenths by half a sixteenth. */
export function swungStepTick(step: number, swing: number): number {
  const base = step * SIXTEENTH_TICKS;
  if (step % 2 === 0) return base;
  const delay = Math.round(clamp01(swing) * (SIXTEENTH_TICKS / 2));
  return base + delay;
}

export function tickToSample(tick: number, tempo: number): number {
  const bpm = Math.max(1, tempo);
  return Math.round((tick * SAMPLE_RATE * 60) / (bpm * PPQN));
}

export function sampleOffset(sample: number): number {
  return ((sample % FRAMES_PER_BLOCK) + FRAMES_PER_BLOCK) % FRAMES_PER_BLOCK;
}

export function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function rateFromUnit(unit: number): Rate {
  if (unit >= 1) return RATES[RATES.length - 1];
  const index = Math.min(RATES.length - 1, Math.max(0, Math.floor(clamp01(unit) * RATES.length)));
  return RATES[index];
}

/** Count includes the original hit. 0 maps to 1 (ratchet off, single note). */
export function countFromUnit(unit: number, max = 8): number {
  const steps = Math.max(1, max);
  return 1 + Math.min(steps - 1, Math.floor(clamp01(unit) * steps));
}

export function unitForIndex(index: number, count: number): number {
  return (index + 0.5) / count;
}
