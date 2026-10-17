import { clamp01 } from "./clock.ts";
import { motif } from "./motif.ts";
import type { Modulated } from "./types.ts";

export function modulated(value: number, pattern = 0, cycle = 1, amount = 0): Modulated {
  return { value, pattern, cycle, amount };
}

/** Cycle is a length in sixteenths. The lane runs on its own; a note reads the value at its step. */
export function evalModulated(m: Modulated, step: number): number {
  const cycle = Math.max(1, Math.round(m.cycle));
  const phase = (((step % cycle) + cycle) % cycle) / cycle;
  if (m.amount === 0) return clamp01(m.value);
  return clamp01(m.value + motif(m.pattern, phase) * m.amount);
}

export function withMacro(m: Modulated, offset: number): Modulated {
  if (!offset) return m;
  return { ...m, value: clamp01(m.value + offset) };
}

/** Performance offset for one sound field. DECAY also lengthens a melodic release. */
export function soundMacro(id: string, macros: Record<string, number>): number {
  const direct = macros[id] ?? 0;
  if (id === "release") return direct + (macros.decay ?? 0);
  return direct;
}

/** Unit 0.5 is the centre. Span is the positive reach in musical units. */
export function bipolarFromUnit(unit: number, span: number): number {
  return (clamp01(unit) - 0.5) * 2 * span;
}
