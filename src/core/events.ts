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
  seed: number,
  lane: LaneId,
  velocityMacro = 0,
): Hit[] {
  // Span may exceed a single Euclidean ring — rings tile via step % length so
  // pitched lanes can cover the full chord phrase.
  const span = Math.max(1, Math.round(steps));
  const hits: Hit[] = [];
  for (let step = 0; step < span; step++) {
    const fired: (1 | 2)[] = [];
    let velocity = 0;
    for (const which of [1, 2] as const) {
      const gen = which === 1 ? gen1 : gen2;
      const length = Math.max(0, Math.round(gen.length));
      if (length <= 0) continue;
      const h = Math.max(0, Math.min(length, Math.round(gen.hits)));
      if (h <= 0) continue;
      const pattern = rotatePattern(euclidPattern(h, length), gen.rotate);
      const local = ((step % length) + length) % length;
      if (!pattern[local]) continue;
      const probability = clamp01(gen.probability);
      if (probability <= 0) continue;
      if (probability < 1 && hash01(seed, lane, which, "prob", step) >= probability) continue;
      fired.push(which);
      velocity = Math.max(velocity, evalModulated(withMacro(gen.velocity, velocityMacro), step));
    }
    if (fired.length) hits.push({ step, generators: fired, velocity });
  }
  return hits;
}
