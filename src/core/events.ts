import { clamp01, sixteenthSteps } from "./clock.ts";
import { hash01 } from "./hash.ts";
import type { EventGen, EventPart, Form, LaneId } from "./types.ts";

export interface ResolvedForm {
  formSteps: number;
  phraseSteps: number;
  partAt(step: number): "a" | "b";
  variationIndex(step: number): number;
}

export function resolveForm(form: Form, beatsPerBar: number): ResolvedForm {
  const formSteps = sixteenthSteps(form.length, beatsPerBar);
  const repeats = Math.max(1, Math.round(form.repeats));
  const phraseSteps = formSteps * repeats;
  const unit = Math.max(1, Math.round(form.varEvery)) * Math.max(1, Math.round(form.varDiv));
  const varCount = Math.max(1, Math.round(form.varCount));
  return {
    formSteps,
    phraseSteps,
    partAt(step) {
      const pos = ((step % formSteps) + formSteps) % formSteps;
      return pos < clamp01(form.abSplit) * formSteps ? "a" : "b";
    },
    variationIndex(step) {
      if (varCount <= 1 || form.varAmount === 0) return 0;
      return Math.floor(Math.max(0, step) / unit) % varCount;
    },
  };
}

export interface Hit {
  step: number;
  part: "a" | "b";
  variation: number;
  generators: (1 | 2)[];
  level: number;
}

export function varyGen(
  gen: EventGen,
  amount: number,
  seed: number,
  lane: LaneId,
  part: "a" | "b",
  which: 1 | 2,
  variation: number,
): EventGen {
  if (variation === 0 || amount === 0) return gen;
  const cycle = Math.max(1, Math.round(gen.cycle));
  const level = clamp01(gen.level + (hash01(seed, lane, part, which, "varL", variation) * 2 - 1) * amount);
  const offset = Math.round(gen.offset + (hash01(seed, lane, part, which, "varO", variation) * 2 - 1) * amount * cycle);
  return { level, cycle: gen.cycle, offset };
}

function onGrid(gen: EventGen, step: number, seed: number, lane: LaneId, part: "a" | "b", which: 1 | 2, variation: number): boolean {
  const cycle = Math.max(1, Math.round(gen.cycle));
  const offset = Math.round(gen.offset);
  const phase = ((step - offset) % cycle + cycle) % cycle;
  if (phase !== 0 || gen.level <= 0) return false;
  if (gen.level >= 1) return true;
  return hash01(seed, lane, part, which, variation, step) < gen.level;
}

/** Union of two independent grids. One step is at most one source event. */
export function generateHits(
  events: { a: EventPart; b: EventPart },
  form: Form,
  steps: number,
  seed: number,
  lane: LaneId,
  beatsPerBar: number,
): Hit[] {
  const resolved = resolveForm(form, beatsPerBar);
  const hits: Hit[] = [];
  const limit = Math.min(steps, resolved.phraseSteps);
  for (let step = 0; step < limit; step++) {
    const part = resolved.partAt(step);
    const variation = resolved.variationIndex(step);
    const fired: (1 | 2)[] = [];
    let level = 0;
    for (const which of [1, 2] as const) {
      const raw = which === 1 ? events[part].g1 : events[part].g2;
      const gen = varyGen(raw, form.varAmount, seed, lane, part, which, variation);
      if (!onGrid(gen, step, seed, lane, part, which, variation)) continue;
      fired.push(which);
      level = Math.max(level, gen.level);
    }
    if (fired.length) hits.push({ step, part, variation, generators: fired, level });
  }
  return hits;
}
