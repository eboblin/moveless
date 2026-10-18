import { clamp01 } from "./clock.ts";
import { hash01 } from "./hash.ts";
import { evalModulated, withMacro } from "./modulate.ts";
import type { EuclidGen, LaneId } from "./types.ts";

export interface Hit {
  step: number;
  generators: (1 | 2)[];
  velocity: number;
}

export function phraseStepsOf(gen1: EuclidGen, gen2: EuclidGen): number {
  const a = Math.max(0, Math.round(gen1.length));
  const b = Math.max(0, Math.round(gen2.length));
  return Math.max(1, a, b);
}

/** Euclidean distribution with an onset on step 0 when hits > 0. */
export function euclidPattern(hits: number, steps: number): boolean[] {
  const n = Math.max(0, Math.round(steps));
  const k = Math.max(0, Math.min(n, Math.round(hits)));
  const out = Array.from({ length: n }, () => false);
  if (n === 0 || k === 0) return out;
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor((i * k) / n) !== Math.floor(((i - 1) * k) / n);
  }
  return out;
}

export function rotatePattern(pattern: readonly boolean[], rotate: number): boolean[] {
  const n = pattern.length;
  if (!n) return [];
  const r = ((Math.round(rotate) % n) + n) % n;
  return pattern.map((_, i) => pattern[(i - r + n) % n]);
}

/** Union of two Euclidean rings. Phrase length is max(length1, length2). */
export function generateHits(
  gen1: EuclidGen,
  gen2: EuclidGen,
  steps: number,
  velocityMacro = 0,
): Hit[] {
  // Span may exceed a single Euclidean ring — rings tile via step % length so
  // pitched lanes can cover the full chord phrase.
  const span = Math.max(1, Math.round(steps));
  const rings: (boolean[] | null)[] = [];
  const lengths: number[] = [];
  for (const gen of [gen1, gen2]) {
    const length = Math.max(0, Math.round(gen.length));
    lengths.push(length);
    const hits = length > 0 ? Math.max(0, Math.min(length, Math.round(gen.hits))) : 0;
    rings.push(hits > 0 ? rotatePattern(euclidPattern(hits, length), gen.rotate) : null);
  }
  const hits: Hit[] = [];
  for (let step = 0; step < span; step++) {
    const fired: (1 | 2)[] = [];
    let velocity = 0;
    for (const which of [1, 2] as const) {
      const gen = which === 1 ? gen1 : gen2;
      const pattern = rings[which - 1];
      const length = lengths[which - 1] ?? 0;
      if (!pattern || length <= 0) continue;
      const local = ((step % length) + length) % length;
      if (!pattern[local]) continue;
      fired.push(which);
      velocity = Math.max(velocity, evalModulated(withMacro(gen.velocity, velocityMacro), step));
    }
    if (fired.length) hits.push({ step, generators: fired, velocity });
  }
  return hits;
}

/** Probability is the last gate: each ratchet and each repeat rolls on its own. */
export function keptVelocity(
  gen1: EuclidGen,
  gen2: EuclidGen,
  generators: readonly (1 | 2)[],
  seed: number,
  lane: LaneId,
  step: number,
  index: number,
  velocityMacro = 0,
  probabilityMacro = 0,
): number | null {
  let velocity = 0;
  let any = false;
  for (const which of generators) {
    const gen = which === 1 ? gen1 : gen2;
    const probability = clamp01(gen.probability + probabilityMacro);
    if (probability <= 0) continue;
    if (probability < 1 && hash01(seed, lane, which, "prob", step, index) >= probability) continue;
    any = true;
    velocity = Math.max(velocity, evalModulated(withMacro(gen.velocity, velocityMacro), step));
  }
  return any ? velocity : null;
}
