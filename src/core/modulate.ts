import { clamp01 } from "./clock.ts";
import { motif } from "./motif.ts";
import { macroOffset } from "./pages.ts";
import { LANES, type LaneId, type Modulated } from "./types.ts";

export function modulated(value: number, pattern = 0, cycle = 1, amount = 0): Modulated {
  return { value, pattern, cycle, amount };
}

/** Pattern below zero names a voice. -1 is kick, -7 is chords. The lane itself is included. */
export function voiceLane(pattern: number): LaneId | null {
  const id = Math.round(pattern);
  if (id >= 0) return null;
  return LANES[-id - 1] ?? null;
}

/**
 * While a phrase is being read, a voice pattern samples the lane envelope at this step.
 * Outside that pass the call stays at the centre: the notes do not exist yet.
 */
let voiceAt: ((pattern: number, step: number) => number) | null = null;

export function hearVoices<T>(envelopeAt: (pattern: number, step: number) => number, read: () => T): T {
  const previous = voiceAt;
  voiceAt = envelopeAt;
  try {
    return read();
  } finally {
    voiceAt = previous;
  }
}

/**
 * Cycle is a length in sixteenths. The lane runs on its own; a note reads the value at its step.
 * A voice source has no motif. It reads the envelope at that same step.
 */
export function evalModulated(m: Modulated, step: number): number {
  if (m.amount === 0) return clamp01(m.value);
  if (m.pattern < 0) {
    if (!voiceAt) return clamp01(m.value);
    return applyVoiceEnvelope(m.value, voiceAt(m.pattern, step), m.amount);
  }
  const cycle = Math.max(1, Math.round(m.cycle));
  const phase = (((step % cycle) + cycle) % cycle) / cycle;
  return clamp01(m.value + motif(m.pattern, phase) * m.amount);
}

/**
 * Live voice modulator. Amount is three times the envelope, then clamped:
 * past full scale more of the curve sits at 1. The screen draws this same number.
 */
export function applyVoiceEnvelope(value: number, envelope: number, amount: number): number {
  return clamp01(value + envelope * amount * 3);
}

export function withMacro(m: Modulated, offset: number): Modulated {
  if (!offset) return m;
  return { ...m, value: clamp01(m.value + offset) };
}

/** Performance offset for one sound field. DECAY also lengthens a melodic release. */
export function soundMacro(id: string, macros: Record<string, number>): number {
  return macroOffset(id, macros);
}

/** Unit 0.5 is the centre. Span is the positive reach in musical units. */
export function bipolarFromUnit(unit: number, span: number): number {
  return (clamp01(unit) - 0.5) * 2 * span;
}
