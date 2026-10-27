import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { sampleOffset, SIXTEENTH_TICKS, unitForIndex } from "../src/core/clock.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { euclidPattern, phraseStepsOf } from "../src/core/events.ts";
import { applyMorph } from "../src/core/morph.ts";
import { motif, MOTIF_COUNT } from "../src/core/motif.ts";
import { evalModulated, modulated, voiceLane } from "../src/core/modulate.ts";
import {
  addSceneToSet,
  advance,
  randomizeLane,
  randomizePaths,
  randomizeSurface,
  createSet,
  launchScene,
  pickWanderCandidate,
  record,
  recordInto,
  pasteClipboard,
  removeSceneFromJournal,
  removeSceneFromSet,
  sceneColor,
  sceneIdsForPads,
  journalPadIds,
  journalPageCount,
  wanderCandidates,
  wanderLanes,
  setRandomizeDepth,
  setRandomizeIntensity,
  commitMacro,
  setMacro,
  audibleEvents,
  heardFx,
} from "../src/core/performance.ts";
import { generatePhrase, unitForOctave } from "../src/core/phrase.ts";
import { chordSymbol, degreeNumeral, pitchClassOfDegree, scaleOf } from "../src/core/harmony.ts";
import { holdNote, latchedPcs, releaseChannel, resetLatch, settleLatch } from "../src/core/latch.ts";
import { chordLabels, textPreview } from "../src/core/text-preview.ts";
import { fieldsOf, getPath } from "../src/core/fields.ts";
import { hash01 } from "../src/core/hash.ts";
import { SOUND, bindingFor, livePage, macroOffset, pagesFor } from "../src/core/pages.ts";
import { LANES, PATTERN_LANES, type PatternId, type Project, type ScaleId } from "../src/core/types.ts";
import { hasSoundMap } from "../src/dsp/map.ts";
import { punch } from "../src/core/morph.ts";

function bar(project: Project, bars = 1): Project {
  const next = clone(project);
  const steps = Math.max(1, Math.round(bars)) * Math.max(1, Math.round(next.global.bar)) * 4;
  for (const lane of ["kick", "snare", "hat", "perc", "bass", "lead"] as const) {
    next.working[lane].gen1.length = steps;
    next.working[lane].gen1.hits = 1;
    next.working[lane].gen2.length = 0;
  }
  next.working.chords.gen1.hits = 1;
  next.global.phrase = bars;
  return next;
}

function modulatedFields(value: unknown, out: Array<{ pattern: number; cycle: number; amount: number }> = []) {
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  if (
    typeof record.cycle === "number" &&
    typeof record.value === "number" &&
    typeof record.pattern === "number" &&
    typeof record.amount === "number"
  ) {
    out.push({ pattern: record.pattern, cycle: record.cycle, amount: record.amount });
    return out;
  }
  for (const child of Object.values(record)) modulatedFields(child, out);
  return out;
}

describe("motif and clock", () => {
  it("keeps every motif inside -1..1", () => {
    for (let id = 0; id < MOTIF_COUNT; id++) {
      for (let i = 0; i < 8; i++) {
        const sample = motif(id, i / 8);
        assert.ok(sample >= -1 && sample <= 1);
        assert.equal(sample, motif(id, i / 8));
      }
    }
  });

  it("stores the bank version on the project", () => {
    assert.equal(defaultProject().motifBankVersion, 1);
  });
});

describe("euclid generator", () => {
  it("parks a silent unshifted ring of length 16 on every generator", () => {
    const lanes = defaultProject().working;
    for (const id of ["kick", "snare", "hat", "perc", "bass", "lead"] as const) {
      for (const gen of ["gen1", "gen2"] as const) {
        const item = lanes[id][gen];
        assert.equal(item.length, 16);
        assert.equal(item.hits, 0);
        assert.equal(item.rotate, 0);
        assert.equal(item.probability, 1);
      }
    }
    assert.equal(lanes.chords.gen1.length, 16);
    assert.equal(lanes.chords.gen1.hits, 0);
    assert.equal(lanes.chords.gen1.rotate, 0);
    assert.equal(lanes.chords.gen1.probability, 1);
    assert.equal(lanes.chords.size.value, 1);
    assert.equal(lanes.chords.probability.value, 1);
    assert.equal(lanes.chords.rate.value, 0.01);
    assert.equal(lanes.chords.gate.value, 0.06);
    assert.equal(lanes.chords.tone.value, 0);
    for (const id of ["kick", "snare", "hat", "perc", "bass", "lead", "chords"] as const) {
      assert.equal(lanes[id].filter.cutoff.value, 0.5);
      assert.equal(lanes[id].filter.resonance.value, 0);
    }
    const kick = lanes.kick.sound;
    assert.equal(kick.pitch.value, 0.12);
    assert.equal(kick.decay.value, 0.1);
    assert.equal(kick.bend.value, 0.77);
    assert.equal(kick.bendTime.value, 0.44);
    assert.equal(kick.body.value, 0.18);
    assert.equal(kick.click.value, 0.24);
    assert.equal(kick.noise.value, 0.05);
    assert.equal(kick.drive.value, 0.01);
    const snare = lanes.snare.sound;
    assert.equal(snare.pitch.value, 0.03);
    assert.equal(snare.body.value, 0.38);
    assert.equal(snare.bodyDecay.value, 0.1);
    assert.equal(snare.noise.value, 0.17);
    assert.equal(snare.noiseDecay.value, 0.19);
    assert.equal(snare.snap.value, 0.08);
    assert.equal(snare.tone.value, 0.28);
    assert.equal(snare.drive.value, 0.12);
    const hat = lanes.hat.sound;
    assert.equal(hat.pitch.value, 0);
    assert.equal(hat.metal.value, 0);
    assert.equal(hat.noise.value, 0.09);
    assert.equal(hat.color.value, 0);
    assert.equal(hat.decay.value, 0.19);
    assert.equal(hat.attack.value, 0.35);
    assert.equal(hat.ring.value, 0.32);
    assert.equal(hat.pos.value, 0.5);
    const perc = lanes.perc.sound;
    assert.equal(perc.pitch.value, 0.23);
    assert.equal(perc.material.value, 0.6);
    assert.equal(perc.decay.value, 0.14);
    assert.equal(perc.bend.value, 0.36);
    assert.equal(perc.fm.value, 0);
    assert.equal(perc.fmRatio.value, 0.29);
    assert.equal(perc.attack.value, 0.16);
    assert.equal(perc.damp.value, 0.11);
    const bass = lanes.bass;
    assert.equal(bass.gen1.velocity.value, 0.8);
    assert.equal(bass.gen2.velocity.value, 0.3);
    assert.equal(bass.pitch.value, 0.5);
    assert.equal(bass.octave.value, unitForOctave(3));
    assert.equal(bass.length.value, 0.04);
    assert.equal(bass.follow, 1);
    assert.equal(bass.step.value, 0);
    assert.equal(bass.sound.wave.value, 0.28);
    assert.equal(bass.sound.bend.value, 0);
    assert.equal(bass.sound.glide.value, 0);
    assert.equal(bass.sound.sustain.value, 1);
    assert.equal(bass.sound.env.value, 0);
    assert.equal(bass.sound.sync.value, 0);
    assert.equal(bass.sound.fold.value, 0);
    assert.equal(bass.sound.drive.value, 0);
    assert.equal(bass.sound.wide.value, 0);
    assert.equal(bass.sound.attack.value, 0.15);
    assert.equal(bass.sound.release.value, 0.09);
    const lead = lanes.lead;
    assert.equal(lead.gen1.velocity.value, 0.4);
    assert.equal(lead.gen2.velocity.value, 0.55);
    assert.equal(lead.pitch.value, 0.5);
    assert.equal(lead.octave.value, unitForOctave(4));
    assert.equal(lead.length.value, 0.1);
    assert.equal(lead.follow, 1);
    assert.equal(lead.step.value, 0);
    assert.equal(lead.sound.wave.value, 0.84);
    assert.equal(lead.sound.bend.value, 0);
    assert.equal(lead.sound.glide.value, 0);
    assert.equal(lead.sound.sustain.value, 1);
    assert.equal(lead.sound.env.value, 0);
    assert.equal(lead.sound.sync.value, 0);
    assert.equal(lead.sound.fold.value, 0);
    assert.equal(lead.sound.drive.value, 0);
    assert.equal(lead.sound.wide.value, 0);
    assert.equal(lead.sound.attack.value, 0.23);
    assert.equal(lead.sound.release.value, 0.01);
  });

  it("parks repeat count and rate at zero on every lane", () => {
    const lanes = defaultProject().working;
    for (const id of ["kick", "snare", "hat", "perc"] as const) {
      assert.equal(lanes[id].ratchet.count.value, 0);
      assert.equal(lanes[id].ratchet.rate.value, 0);
    }
    assert.equal(lanes.bass.repeat.value, 0);
    assert.equal(lanes.lead.repeat.value, 0);
    assert.equal(lanes.chords.rate.value, 0.01);
  });

  it("rests every VPCA generator", () => {
    const fields = modulatedFields(defaultProject().working);
    assert.ok(fields.length > 10);
    for (const field of fields) {
      assert.equal(field.pattern, 0);
      assert.equal(field.cycle, 1);
      assert.equal(field.amount, 0);
    }
  });

  it("places a four-on-the-floor kick on every fourth sixteenth", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    const line = textPreview(project).split("\n")[0];
    assert.equal(line, "KCK x---x---x---x---");
  });

  it("unions a second generator without stacking two events on one step", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.kick.gen2 = { ...project.working.kick.gen2, length: 16, hits: 2, rotate: 2 };
    const steps = [...new Set(generatePhrase(project).lanes.kick.map((event) => event.step))];
    assert.deepEqual(steps, [0, 2, 4, 8, 10, 12]);
  });

  it("stays silent at hits 0 and ignores the scene id", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1.hits = 0;
    project.working.kick.gen2.hits = 0;
    assert.equal(generatePhrase(project).lanes.kick.length, 0);
    const other = clone(project);
    other.nextSceneId = 99;
    other.journal = [{ id: "ghost", lanes: clone(project.working) }];
    assert.deepEqual(generatePhrase(project).lanes.kick, generatePhrase(other).lanes.kick);
  });

  it("repeats for the same seed", () => {
    const project = defaultProject();
    assert.deepEqual(generatePhrase(project), generatePhrase(project));
  });

  it("keeps hits deterministic across seeds when variation is 0", () => {
    const project = bar(defaultProject());
    const first = generatePhrase(project).lanes.kick.map((event) => event.step);
    project.global.seed = 50;
    assert.deepEqual(generatePhrase(project).lanes.kick.map((event) => event.step), first);
  });

  it("keeps probability 1 identical across seeds and thins hits when probability drops", () => {
    const base = bar(defaultProject());
    base.working.kick.gen1.probability = 1;
    const full = generatePhrase(base).lanes.kick.map((event) => event.step);
    base.global.seed = 50;
    assert.deepEqual(generatePhrase(base).lanes.kick.map((event) => event.step), full);
    let thinned = false;
    for (let seed = 1; seed <= 40 && !thinned; seed++) {
      base.global.seed = seed;
      base.working.kick.gen1.probability = 0.35;
      const steps = generatePhrase(base).lanes.kick.map((event) => event.step);
      thinned = steps.length < full.length;
    }
    assert.equal(thinned, true);
    base.working.kick.gen1.probability = 0;
    assert.equal(generatePhrase(base).lanes.kick.length, 0);
  });

  it("spreads probability so dense hits thin gradually across the knob", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 16, rotate: 0 };
    project.working.kick.gen2.hits = 0;
    const counts = new Set<number>();
    for (let i = 0; i <= 20; i++) {
      project.working.kick.gen1.probability = i / 20;
      counts.add(generatePhrase(project).lanes.kick.length);
    }
    assert.ok(counts.size >= 8, `expected gradual thinning, got ${[...counts].sort((a, b) => a - b)}`);
    assert.ok(counts.has(0));
    assert.ok(counts.has(16));
  });

  it("uses max length as the phrase and loops the shorter ring", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1.length = 8;
    project.working.kick.gen1.hits = 1;
    project.working.kick.gen1.rotate = 0;
    project.working.kick.gen2.length = 12;
    project.working.kick.gen2.hits = 0;
    assert.equal(phraseStepsOf(project.working.kick.gen1, project.working.kick.gen2), 12);
    const steps = generatePhrase(project).lanes.kick.map((event) => event.step);
    assert.deepEqual(steps, [0, 8]);
  });

  it("builds an onset-on-zero euclid ring", () => {
    assert.deepEqual(
      euclidPattern(4, 16).map((hit) => (hit ? "x" : "-")).join(""),
      "x---x---x---x---",
    );
  });

  it("expands ratchet counts inside one source event", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    project.working.kick.ratchet.count = modulated(0.4);
    project.working.kick.ratchet.rate = modulated(unitForIndex(1, 6));
    const ticks = generatePhrase(project).lanes.kick.filter((event) => event.step === 0).map((event) => event.tick);
    assert.deepEqual(ticks, [0, 48, 96, 144]);
  });

  it("thins each ratchet and each repeat on its own", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 1, rotate: 0, probability: 0.45 };
    project.working.kick.gen2.hits = 0;
    project.working.kick.ratchet.count = modulated(1);
    project.working.kick.ratchet.rate = modulated(unitForIndex(1, 6));
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 1, rotate: 0, probability: 0.45 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.repeat = modulated(1);
    let kickPartial = false;
    let bassPartial = false;
    for (let seed = 1; seed <= 40 && (!kickPartial || !bassPartial); seed++) {
      project.global.seed = seed;
      const kick = generatePhrase(project).lanes.kick.length;
      const bass = generatePhrase(project).lanes.bass.length;
      kickPartial = kickPartial || (kick > 0 && kick < 8);
      bassPartial = bassPartial || (bass > 0 && bass < 8);
    }
    assert.equal(kickPartial, true);
    assert.equal(bassPartial, true);
  });

  it("reads generator velocity after count and rate have placed each note", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    project.working.kick.ratchet.count = modulated(0.4);
    project.working.kick.ratchet.rate = modulated(unitForIndex(3, 6));
    project.working.kick.gen1.velocity = modulated(0.5, 0, 16, 0.5);
    const kicks = generatePhrase(project).lanes.kick;
    const kickCurve = (step: number) => evalModulated(project.working.kick.gen1.velocity, step);
    assert.deepEqual(kicks.map((event) => event.tick), [0, 24, 48, 72]);
    assert.deepEqual(kicks.map((event) => event.velocity), [0, 0.5, 1, 1.5].map(kickCurve));
    assert.notEqual(kicks[0].velocity, kicks[1].velocity);

    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.repeat = modulated(0.4);
    project.working.bass.gen1.velocity = modulated(0.5, 0, 16, 0.5);
    const bass = generatePhrase(project).lanes.bass.filter((event) => event.step === 0);
    const bassCurve = (step: number) => evalModulated(project.working.bass.gen1.velocity, step);
    assert.equal(bass.length, 4);
    assert.deepEqual(bass.map((event) => event.velocity), [0, 1, 2, 3].map(bassCurve));
  });

  it("keeps a voice pattern at the centre of the phrase", () => {
    assert.equal(voiceLane(0), null);
    assert.equal(voiceLane(-1), "kick");
    assert.equal(voiceLane(-5), "bass");
    assert.equal(voiceLane(-7), "chords");
    assert.equal(voiceLane(-8), null);
    assert.equal(evalModulated(modulated(0.4, -1, 4, 1), 3), 0.4);
    const binding = bindingFor("filter.cutoff.pattern");
    assert.equal(binding?.min, -7);
    assert.equal(binding?.max, 63);
    assert.ok(binding?.detents?.includes(0));

    const project = bar(defaultProject());
    project.working.kick.sound.pitch = modulated(0.35, -1, 8, 1);
    project.working.kick.filter.cutoff.pattern = -1;
    project.working.kick.filter.cutoff.cycle = 8;
    const page = livePage(project, "kick", 7);
    assert.equal(page?.bindings[1]?.path, "filter.cutoff.pattern");
    assert.equal(page?.bindings[2], null);
    assert.equal(page?.bindings[3]?.path, "filter.cutoff.amount");
    assert.equal(project.working.kick.filter.cutoff.cycle, 8);
    project.working.kick.filter.cutoff.pattern = 2;
    assert.equal(livePage(project, "kick", 7)?.bindings[2]?.path, "filter.cutoff.cycle");
    const kicks = generatePhrase(project).lanes.kick;
    assert.ok(kicks.length > 0);
    for (const event of kicks) assert.ok(event.sound.pitch > 0.35);
  });

  it("reads a voice envelope at the generator step", () => {
    const project = bar(defaultProject());
    project.working.kick.ratchet.count = modulated(0, -1, 4, 1);
    const kicks = generatePhrase(project).lanes.kick;
    assert.ok(kicks.length > 1);
    const quiet = bar(defaultProject());
    quiet.working.kick.ratchet.count = modulated(0, -1, 4, 0);
    assert.equal(generatePhrase(quiet).lanes.kick.length, 1);
  });

  it("reads a modulator at the note time rather than the note count", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    project.working.kick.sound.pitch = modulated(0.5, 0, 16, 1);
    const kicks = generatePhrase(project).lanes.kick;
    const at = (step: number) => kicks.find((event) => event.step === step)?.sound.pitch;
    assert.equal(at(0), 0.5);
    assert.equal(at(4), 1);
  });

  it("delays odd sixteenths with swing and keeps block offsets in range", () => {
    const project = bar(defaultProject());
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.kick.gen2 = { ...project.working.kick.gen2, length: 16, hits: 8, rotate: 1 };
    project.global.swing = 1;
    const kick = generatePhrase(project).lanes.kick;
    const first = kick.find((event) => event.step === 0);
    const off = kick.find((event) => event.step === 1);
    const even = kick.find((event) => event.step === 4);
    assert.equal(first?.tick, 0);
    assert.equal(even?.tick, 192);
    assert.ok((off?.tick ?? 0) > 48);
    for (const event of kick) {
      assert.ok(event.sampleOffset >= 0 && event.sampleOffset < 128);
      assert.equal(event.sampleOffset, sampleOffset(event.sample));
    }
  });
});

describe("morph, journal, macros", () => {
  it("keeps the project while a morph has not moved a lane", () => {
    let project = record(defaultProject());
    project = launchScene(project, project.journal[0].id, 0);
    assert.ok(project.morph);
    assert.equal(applyMorph(project, 0), project);
    assert.equal(applyMorph(project, 1), project);
  });

  it("spreads switch knobs across the window and keeps a modulator's pattern with its cycle", () => {
    let project = defaultProject();
    project = punch(project, "kick.gen1.velocity.value", 0);
    project = punch(project, "kick.ratchet.count.pattern", 2);
    project = punch(project, "kick.sound.decay.pattern", 1);
    project = punch(project, "kick.sound.decay.cycle", 64);
    project = punch(project, "kick.sound.decay.value", 0);
    project = record(project);
    project = punch(project, "kick.gen1.velocity.value", 1);
    project = punch(project, "kick.ratchet.count.pattern", 10);
    project = punch(project, "kick.ratchet.count.cycle", 4);
    project = punch(project, "kick.sound.decay.pattern", 8);
    project = punch(project, "kick.sound.decay.cycle", 4);
    project = punch(project, "kick.sound.decay.value", 1);
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "fast";
    project = launchScene(project, "002", 0);
    const duration = 4 * 192;
    assert.equal(project.morph?.durationTicks, duration);
    const before = applyMorph(project, SIXTEENTH_TICKS - 1);
    assert.equal(before.working.kick.ratchet.count.pattern, 2);
    assert.equal(before.working.kick.ratchet.count.cycle, 1);
    assert.equal(before.working.kick.gen1.velocity.value, 0);
    const held = applyMorph(project, 191);
    assert.equal(held.working.kick.gen1.velocity.value, 0);
    assert.equal(held.working.kick.ratchet.count.pattern, 2);
    const atBeat = applyMorph(held, 192);
    assert.equal(atBeat.working.kick.gen1.velocity.value, 1);
    assert.equal(atBeat.working.kick.ratchet.count.pattern, 2);
    assert.equal(atBeat.working.kick.sound.decay.value, 0.25);
    const quarter = applyMorph(project, duration / 4);
    assert.equal(quarter.working.kick.sound.decay.value, 0.25);
    const half = applyMorph(project, duration / 2);
    assert.equal(half.working.kick.sound.decay.value, 0.5);
    assert.equal(half.working.kick.gen1.velocity.value, 1);
    assert.equal(half.working.kick.ratchet.count.pattern, 10);
    assert.equal(half.working.kick.ratchet.count.cycle, 4);
    assert.equal(half.working.kick.sound.decay.pattern, 1);
    assert.equal(half.working.kick.sound.decay.cycle, 64);
    assert.deepEqual(kickSig(generatePhrase(half)), kickSig(generatePhrase({ ...half, morph: null })));
    const pattern = applyMorph(project, 576);
    assert.equal(pattern.working.kick.sound.decay.pattern, 8);
    assert.equal(pattern.working.kick.sound.decay.cycle, 4);
    assert.equal(pattern.working.kick.sound.decay.value, 0.75);
    const done = applyMorph(project, duration);
    assert.equal(done.morph, null);
    assert.equal(done.activeSceneId, "002");
    assert.equal(done.working.kick.gen1.velocity.value, 1);
    assert.equal(done.working.kick.ratchet.count.pattern, 10);
    assert.equal(done.working.kick.sound.decay.pattern, 8);
    assert.equal(done.working.kick.sound.decay.cycle, 4);
    assert.equal(done.working.kick.sound.decay.value, 1);
  });

  it("advance lands a saved scene once the clock reaches it", () => {
    let project = defaultProject();
    project = punch(project, "kick.gen1.velocity.value", 0.25);
    project = record(project);
    assert.equal(project.journal[0].color, sceneColor("001"));
    project = punch(project, "kick.gen1.velocity.value", 0.9);
    project.transition = "now";
    project = launchScene(project, "001", 0);
    project = advance(project, 0);
    assert.equal(project.morph, null);
    assert.equal(project.working.kick.gen1.velocity.value, 0.25);
    project = punch(project, "kick.gen1.velocity.value", 0.2);
    project.transition = "fast";
    project = launchScene(project, "001", 10);
    const waiting = advance(project, 10);
    assert.ok(waiting.morph);
    assert.equal(waiting.working.kick.gen1.velocity.value, 0.2);
    assert.ok((waiting.morph?.originTick ?? 0) > 10);
    const finished = advance(waiting, (waiting.morph?.originTick ?? 0) + (waiting.morph?.durationTicks ?? 0));
    assert.equal(finished.morph, null);
    assert.equal(finished.working.kick.gen1.velocity.value, 0.25);
  });

  it("retargets from the interpolated state and leaves locked lanes alone", () => {
    let project = defaultProject();
    project = punch(project, "snare.gen1.velocity.value", 0);
    project = punch(project, "snare.sound.bodyDecay.value", 0);
    project = record(project);
    project = punch(project, "snare.gen1.velocity.value", 1);
    project = punch(project, "snare.sound.bodyDecay.value", 1);
    project = punch(project, "kick.gen1.velocity.value", 0);
    project = record(project);
    project = punch(project, "kick.gen1.velocity.value", 1);
    project = punch(project, "snare.gen1.velocity.value", 1);
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.working.kick.gen1.velocity.value = 0;
    project.transition = "slow";
    project = launchScene(project, "002", 0);
    project = applyMorph(project, 2 * 4 * 192);
    assert.equal(project.working.snare.gen1.velocity.value, 0);
    assert.ok(Math.abs(project.working.snare.sound.bodyDecay.value - 0.25) < 1e-9);
    project.lock.kick = true;
    project = launchScene(project, "003", 2 * 192);
    assert.equal(project.morph?.start.snare.gen1.velocity.value, project.working.snare.gen1.velocity.value);
    const finished = applyMorph(project, project.morph!.originTick + project.morph!.durationTicks);
    assert.equal(finished.working.kick.gen1.velocity.value, 0);
    assert.equal(finished.working.snare.gen1.velocity.value, 1);
  });

  it("keeps a punched value through the end of a morph", () => {
    let project = defaultProject();
    project = punch(project, "hat.gen1.velocity.value", 0);
    project = record(project);
    project = punch(project, "hat.gen1.velocity.value", 1);
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project = launchScene(project, "002", 0);
    project = applyMorph(project, 100);
    project = punch(project, "hat.gen1.velocity.value", 0.2);
    const done = applyMorph(project, project.morph!.originTick + project.morph!.durationTicks);
    assert.equal(done.working.hat.gen1.velocity.value, 0.2);
  });

  it("appends an immutable scene and leaves mixer and macros outside it", () => {
    let project = defaultProject();
    project = setMacro(project, "cutoff", 0.25);
    project.mixer.kick = 0.3;
    project = punch(project, "bass.filter.cutoff.value", 0.2);
    project.working.bass.gen1.hits = 1;
    project.working.bass.gen2.hits = 1;
    project = record(project);
    project = punch(project, "bass.filter.cutoff.value", 0.9);
    assert.equal(project.journal[0].lanes.bass.filter.cutoff.value, 0.2);
    assert.equal(project.journal.length, 1);
    assert.equal(project.nextSceneId, 2);
    const heard = generatePhrase(project).lanes.bass[0]?.filter.cutoff;
    assert.equal(project.working.bass.filter.cutoff.value, 0.9);
    assert.ok(heard !== undefined && Math.abs(heard - 1) < 1e-9);
    const saved = generatePhrase({ ...project, working: project.journal[0].lanes, macros: {} }).lanes.bass[0].filter.cutoff;
    assert.ok(Math.abs(saved - 0.2) < 1e-9);
    assert.equal(project.mixer.kick, 0.3);
    project.lock.bass = true;
    const locked = generatePhrase(project).lanes.bass[0].filter.cutoff;
    assert.ok(Math.abs(locked - 0.9) < 1e-9);
  });

  it("does not let a morph rewrite the mixer", () => {
    let project = defaultProject();
    project = record(project);
    project.mixer.master = 0.2;
    project = launchScene(project, "001", 0);
    project = applyMorph(project, 10);
    assert.equal(project.mixer.master, 0.2);
  });

  it("hands kick hits on the first bar and rotate on a later bar", () => {
    let project = defaultProject();
    project.working.kick.gen1.hits = 4;
    project.working.kick.gen1.rotate = 0;
    project.working.kick.sound.decay.value = 0;
    project.working.kick.sound.decay.amount = 0;
    project.progression.start = 0;
    project = record(project);
    project.working.kick.gen1.hits = 7;
    project.working.kick.gen1.rotate = 3;
    project.working.kick.sound.decay.value = 1;
    project.working.kick.sound.decay.amount = 0;
    project.progression.start = 3;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "medium";
    project = launchScene(project, "002", 0);
    const duration = project.morph?.durationTicks ?? 0;
    const loop = phraseStepsOf(project.morph!.start.kick.gen1, project.morph!.start.kick.gen2) * SIXTEENTH_TICKS;
    const start = generatePhrase({ ...project, morph: null, working: project.morph!.start });
    const goal = generatePhrase({ ...project, morph: null, working: project.journal[1].lanes });
    assert.notDeepEqual(kickSig(start), kickSig(goal));
    const before = applyMorph(project, loop - 1);
    assert.equal(before.working.kick.gen1.hits, 4);
    assert.equal(before.working.kick.sound.decay.value, 0);
    assert.deepEqual(kickSig(generatePhrase(before)), kickSig(start));
    assert.deepEqual(generatePhrase(before).harmony.map((event) => event.root), start.harmony.map((event) => event.root));
    const after = applyMorph(project, loop);
    assert.equal(after.working.kick.gen1.hits, 7);
    assert.equal(after.working.kick.gen1.rotate, 0);
    assert.equal(after.working.kick.sound.decay.value, 0.25);
    assert.deepEqual(kickSig(generatePhrase(after)), kickSig(generatePhrase({ ...after, morph: null })));
    const later = applyMorph(project, loop * 3);
    assert.equal(later.working.kick.gen1.hits, 7);
    assert.equal(later.working.kick.gen1.rotate, 3);
    assert.ok(later.morph);
    const done = applyMorph(project, duration);
    assert.equal(done.morph, null);
    assert.equal(done.progression.start, 3);
    assert.equal(done.working.kick.sound.decay.value, 1);
    assert.deepEqual(kickSig(generatePhrase(done)), kickSig(goal));
    assert.deepEqual(generatePhrase(done).harmony.map((event) => event.root), start.harmony.map((event) => event.root));
  });

  it("steps decay in quarters and hands length before rotate", () => {
    let project = defaultProject();
    project.working.kick.gen1.length = 16;
    project.working.kick.gen1.hits = 1;
    project.working.kick.gen1.rotate = 0;
    project.working.kick.gen2.length = 0;
    project.working.kick.sound.decay.value = 0;
    project.working.kick.sound.decay.amount = 0;
    project = record(project);
    project.working.kick.gen1.length = 12;
    project.working.kick.gen1.hits = 1;
    project.working.kick.gen1.rotate = 4;
    project.working.kick.gen2.length = 0;
    project.working.kick.sound.decay.value = 1;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "medium";
    project = launchScene(project, "002", 0);
    const loop = 16 * SIXTEENTH_TICKS;
    const before = applyMorph(project, loop - 1);
    assert.equal(before.working.kick.gen1.length, 16);
    assert.equal(generatePhrase(before).steps.kick, 16);
    assert.equal(generatePhrase(before).lanes.kick[0]?.sound.decay, 0);
    const at = applyMorph(project, loop);
    assert.equal(at.working.kick.gen1.length, 12);
    assert.equal(at.working.kick.gen1.rotate, 0);
    assert.equal(generatePhrase(at).steps.kick, 12);
    assert.ok(Math.abs((generatePhrase(at).lanes.kick[0]?.sound.decay ?? -1) - 0.25) < 1e-9);
    const turned = applyMorph(project, loop * 3);
    assert.equal(turned.working.kick.gen1.length, 12);
    assert.equal(turned.working.kick.gen1.rotate, 4);
    const half = applyMorph(project, (project.morph?.durationTicks ?? 0) / 2);
    assert.ok(Math.abs(half.working.kick.sound.decay.value - 0.5) < 1e-9);
  });

  it("does not morph a locked lane or a punched sound", () => {
    let project = defaultProject();
    project.working.kick.gen1.hits = 1;
    project.working.kick.gen1.rotate = 0;
    project.working.kick.gen2.hits = 0;
    project.working.kick.sound.decay.value = 0;
    project.working.kick.sound.decay.amount = 0;
    project = record(project);
    project.working.kick.gen1.rotate = 8;
    project.working.kick.sound.decay.value = 1;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.lock.kick = true;
    project.transition = "fast";
    project = launchScene(project, "002", 0);
    const duration = project.morph?.durationTicks ?? 0;
    const locked = generatePhrase(applyMorph(project, duration / 2));
    assert.ok(locked.lanes.kick.some((event) => event.tick === 0));
    assert.ok(locked.lanes.kick.every((event) => event.tick % (16 * 48) === 0));
    assert.ok(locked.lanes.kick.every((event) => Math.abs(event.sound.decay) < 1e-6));

    project.lock.kick = false;
    project = launchScene(project, "002", 0);
    project = applyMorph(project, duration * 0.1);
    project = punch(project, "kick.sound.decay.value", 0.2);
    const punched = generatePhrase(applyMorph(project, duration / 2));
    assert.ok(punched.lanes.kick.length > 0);
    assert.ok(punched.lanes.kick.every((event) => Math.abs(event.sound.decay - 0.2) < 1e-6));
  });

  it("spreads bass hits, rotate and pitch across the morph", () => {
    let project = defaultProject();
    project.global.phrase = 1;
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 2, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.pitch.value = 0.2;
    project = record(project);
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 8, rotate: 3, probability: 1 };
    project.working.bass.pitch.value = 0.9;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "medium";
    project = launchScene(project, "002", 0);
    const start = generatePhrase({ ...project, morph: null, working: project.morph!.start });
    const goal = generatePhrase({ ...project, morph: null, working: project.journal[1].lanes });
    assert.notDeepEqual(noteSig(start, "bass"), noteSig(goal, "bass"));
    const before = applyMorph(project, 575);
    assert.equal(before.working.bass.pitch.value, 0.2);
    assert.equal(before.working.bass.gen1.hits, 2);
    assert.equal(before.working.bass.gen1.rotate, 0);
    assert.deepEqual(noteSig(generatePhrase(before), "bass"), noteSig(start, "bass"));
    const hits = applyMorph(project, 576);
    assert.equal(hits.working.bass.gen1.hits, 8);
    assert.equal(hits.working.bass.gen1.rotate, 0);
    assert.equal(hits.working.bass.pitch.value, 0.2);
    assert.deepEqual(noteSig(generatePhrase(hits), "bass"), noteSig(generatePhrase({ ...hits, morph: null }), "bass"));
    assert.ok(hits.morph);
    const turned = applyMorph(project, 1536);
    assert.equal(turned.working.bass.gen1.rotate, 3);
    assert.equal(turned.working.bass.pitch.value, 0.2);
    const pitched = applyMorph(project, 2496);
    assert.equal(pitched.working.bass.pitch.value, 0.9);
    assert.equal(pitched.working.bass.gen1.hits, 8);
    assert.deepEqual(noteSig(generatePhrase(pitched), "bass"), noteSig(goal, "bass"));
    assert.ok(pitched.morph);
  });

  it("hands note velocity before pitch", () => {
    let project = defaultProject();
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.pitch.value = 0.2;
    project.working.bass.pitch.amount = 0;
    project.working.bass.gen1.velocity.value = 0.4;
    project = record(project);
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.pitch.value = 0.9;
    project.working.bass.pitch.amount = 0;
    project.working.bass.gen1.velocity.value = 0.9;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "medium";
    project = launchScene(project, "002", 0);
    const duration = project.morph?.durationTicks ?? 0;
    const start = generatePhrase({ ...project, morph: null, working: project.morph!.start });
    const goal = generatePhrase({ ...project, morph: null, working: project.journal[1].lanes });
    const sourceHit = start.lanes.bass.find((event) => event.tick === 0);
    const destHit = goal.lanes.bass.find((event) => event.tick === 0);
    assert.ok(sourceHit && destHit && sourceHit.note !== destHit.note);
    assert.notEqual(sourceHit.velocity, destHit.velocity);
    const early = applyMorph(project, duration * 0.25);
    const late = applyMorph(project, duration * 0.95);
    assert.equal(early.working.bass.gen1.velocity.value, 0.9);
    assert.equal(early.working.bass.pitch.value, 0.2);
    assert.equal(late.working.bass.gen1.velocity.value, 0.9);
    assert.equal(late.working.bass.pitch.value, 0.9);
    assert.equal(generatePhrase(early).lanes.bass.find((event) => event.tick === 0)?.note, sourceHit.note);
    assert.equal(generatePhrase(early).lanes.bass.find((event) => event.tick === 0)?.velocity, destHit.velocity);
    assert.equal(generatePhrase(late).lanes.bass.find((event) => event.tick === 0)?.note, destHit.note);
    assert.equal(generatePhrase(late).lanes.bass.find((event) => event.tick === 0)?.velocity, destHit.velocity);
    const done = applyMorph(project, duration);
    assert.equal(done.working.bass.gen1.velocity.value, 0.9);
    assert.equal(generatePhrase(done).lanes.bass.find((event) => event.tick === 0)?.note, destHit.note);
    assert.equal(generatePhrase(done).lanes.bass.find((event) => event.tick === 0)?.velocity, destHit.velocity);
  });

  it("steps timbre in quarters while pattern knobs arrive on their own beats", () => {
    const project = morphPair(
      (item) => {
        item.working.bass.pitch.value = 0.2;
        item.working.bass.octave.value = 0.2;
        item.working.bass.follow = 0;
        item.working.bass.gen1.hits = 3;
        item.working.bass.gen1.probability = 0.7;
        item.working.bass.filter.cutoff.value = 0;
        item.working.bass.filter.cutoff.amount = 0;
        item.working.bass.sound.wide.value = 0;
        item.working.bass.sound.wide.amount = 0;
        item.working.kick.sound.pitch.value = 0.15;
        item.working.kick.sound.pitch.amount = 0;
        item.working.lead.pitch.value = 0.25;
        item.progression.start = 0;
        item.progression.mood = 0;
      },
      (item) => {
        item.working.bass.pitch.value = 0.9;
        item.working.bass.octave.value = 0.8;
        item.working.bass.follow = 1;
        item.working.bass.gen1.hits = 6;
        item.working.bass.gen1.probability = 1;
        item.working.bass.filter.cutoff.value = 1;
        item.working.bass.filter.cutoff.amount = 0;
        item.working.bass.sound.wide.value = 1;
        item.working.bass.sound.wide.amount = 0;
        item.working.kick.sound.pitch.value = 0.85;
        item.working.kick.sound.pitch.amount = 0;
        item.working.lead.pitch.value = 0.85;
        item.progression.start = 4;
        item.progression.mood = 1;
      },
    );
    const duration = project.morph?.durationTicks ?? 0;
    const start = generatePhrase({ ...project, morph: null, working: project.morph!.start });
    const riding = applyMorph(project, duration * 0.25);
    assert.equal(riding.working.bass.gen1.hits, 6);
    assert.equal(riding.working.bass.pitch.value, 0.2);
    assert.equal(riding.working.bass.octave.value, 0.2);
    assert.equal(riding.working.bass.follow, 0);
    assert.equal(riding.working.bass.gen1.probability, 0.7);
    assert.ok(Math.abs(riding.working.bass.sound.wide.value - 0.25) < 1e-9);
    assert.ok(Math.abs(riding.working.kick.sound.pitch.value - 0.325) < 1e-9);
    const early = generatePhrase(riding);
    assert.deepEqual(noteSig(early, "bass"), noteSig(generatePhrase({ ...riding, morph: null }), "bass"));
    assert.notDeepEqual(noteSig(early, "bass"), noteSig(start, "bass"));
    assert.deepEqual(noteSig(early, "lead"), noteSig(start, "lead"));
    assert.ok(early.lanes.bass.every((event) => Math.abs(event.filter.cutoff - 0.25) < 1e-6));
    assert.ok(early.lanes.kick.every((event) => Math.abs(event.sound.pitch - 0.325) < 1e-6));
    const late = applyMorph(project, duration * 0.75);
    assert.equal(late.working.bass.pitch.value, 0.9);
    assert.equal(late.working.bass.follow, 0);
    assert.ok(Math.abs(late.working.bass.sound.wide.value - 0.75) < 1e-9);
    const done = applyMorph(project, duration);
    assert.equal(done.morph, null);
    assert.equal(done.progression.start, 4);
    assert.equal(done.working.bass.pitch.value, 0.9);
    assert.equal(done.working.bass.follow, 1);
    assert.equal(done.working.bass.sound.wide.value, 1);
    assert.equal(done.working.kick.sound.pitch.value, 0.85);
  });

  it("holds a melodic note for the length knob", () => {
    const project = bar(defaultProject());
    project.working.bass.gen1.hits = 1;
    project.working.bass.gen1.rotate = 0;
    project.working.bass.gen1.probability = 1;
    project.working.bass.gen2.hits = 0;
    project.working.bass.length = modulated(1);
    const full = generatePhrase(project).lanes.bass[0];
    assert.ok(full);
    assert.equal(full.lengthTicks, project.global.bar * SIXTEENTH_TICKS);
    project.working.bass.length = modulated(0.5);
    assert.equal(generatePhrase(project).lanes.bass[0].lengthTicks, Math.round(0.5 * project.global.bar * SIXTEENTH_TICKS));
    project.working.lead.gen1.hits = 1;
    project.working.lead.gen1.rotate = 0;
    project.working.lead.gen1.probability = 1;
    project.working.lead.gen2.hits = 0;
    project.working.lead.length = modulated(0);
    assert.equal(generatePhrase(project).lanes.lead[0].lengthTicks, 1);
  });

  it("pulls repeats and density across lanes without rewriting them", () => {
    const project = defaultProject();
    project.working.bass.gen1.hits = 1;
    project.working.bass.gen2.hits = 1;
    project.working.kick.gen1.hits = 1;
    project.working.kick.gen2.hits = 1;
    project.working.bass.repeat = modulated(0.5);
    project.working.kick.ratchet.count = modulated(0.5);
    const open = generatePhrase(project);
    const pulled = { ...project, macros: { repeat: -1 } };
    const fewer = generatePhrase(pulled);
    assert.ok(fewer.lanes.bass.length < open.lanes.bass.length);
    assert.ok(fewer.lanes.kick.length < open.lanes.kick.length);
    assert.equal(pulled.working.bass.repeat.value, 0.5);
    assert.equal(pulled.working.kick.ratchet.count.value, 0.5);
    const locked = { ...pulled, lock: { ...pulled.lock, bass: true } };
    const held = generatePhrase(locked);
    assert.equal(held.lanes.bass.length, open.lanes.bass.length);
    assert.ok(held.lanes.kick.length < open.lanes.kick.length);

    const dense = defaultProject();
    dense.working.kick.gen1.hits = 1;
    dense.working.kick.gen2.hits = 1;
    const kickHits = generatePhrase(dense).lanes.kick.length;
    assert.ok(kickHits > 0);
    dense.macros = { probability: -1 };
    assert.equal(generatePhrase(dense).lanes.kick.length, 0);
    assert.equal(dense.working.kick.gen1.probability, 1);
  });
});

function noteSig(phrase: ReturnType<typeof generatePhrase>, lane: "bass" | "lead" | "chords"): string[] {
  return phrase.lanes[lane].map((event) => `${event.tick}:${event.note}:${event.lengthTicks}:${event.velocity}`).sort();
}

function morphPair(setupA: (project: Project) => void, setupB: (project: Project) => void): Project {
  let project = defaultProject();
  setupA(project);
  project = record(project);
  setupB(project);
  project = record(project);
  project.working = clone(project.journal[0].lanes);
  project.transition = "medium";
  return launchScene(project, "002", 0);
}

function kickSig(phrase: ReturnType<typeof generatePhrase>): Array<[number, number, number]> {
  return phrase.lanes.kick.map((event) => [event.tick, event.note, event.velocity]);
}

describe("harmony", () => {
  it("publishes chord context that bass can follow, including when chords are muted", () => {
    const project = bar(defaultProject());
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 2, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.pitch = modulated(0.5 + 1 / 14);
    project.working.bass.follow = 1;
    project.progression.mood = 0;
    project.progression.tension = 0;
    const followed = generatePhrase(project).lanes.bass[0].note;
    project.working.bass.follow = 0;
    const free = generatePhrase(project).lanes.bass[0].note;
    assert.equal(followed, 36);
    assert.equal(free, 38);
    project.mute.chords = true;
    const phrase = generatePhrase(project);
    assert.ok(phrase.harmony.length > 0);
    assert.equal(chordLabels(project)[0], "C");
    const heard = audibleEvents(project, phrase.lanes);
    assert.equal(heard.some((event) => event.lane === "chords"), false);
    assert.equal(heard.some((event) => event.lane === "bass"), true);
  });

  it("lets bass follow later chords by spanning the global phrase, not only the euclid ring", () => {
    const project = defaultProject();
    project.working.bass.gen1.hits = 1;
    project.working.bass.gen2.hits = 1;
    const phrase = generatePhrase(project);
    assert.ok(phrase.harmony.length >= 2, "defaults build more than one chord");
    assert.equal(phrase.steps.bass, phrase.steps.chords);
    const notesByChord = phrase.harmony.map((harm) =>
      [...new Set(
        phrase.lanes.bass
          .filter((event) => event.tick >= harm.startTick && event.tick < harm.startTick + harm.lengthTicks)
          .map((event) => event.note),
      )],
    );
    assert.ok(notesByChord[0].length > 0);
    assert.ok(notesByChord[1].length > 0);
    assert.notDeepEqual(notesByChord[0], notesByChord[1]);
  });

  it("follows the sounding chord tones, including chromatic ones off the scale", () => {
    const project = bar(defaultProject());
    project.global.scale = "minor";
    project.progression.mood = 0;
    project.progression.tension = 0;
    project.progression.count = 1;
    project.working.bass.follow = 1;
    project.working.bass.pitch = modulated(0.5 + 1 / 7);
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 4, rotate: 0 };
    project.working.bass.gen2.hits = 0;
    project.working.chords.rate = modulated(0);
    const phrase = generatePhrase(project);
    const chordPcs = new Set(phrase.lanes.chords.map((event) => ((event.note % 12) + 12) % 12));
    assert.ok(chordPcs.has(4), "maj chord in minor still sounds E");
    for (const event of phrase.lanes.bass) {
      assert.ok(chordPcs.has(((event.note % 12) + 12) % 12), `bass ${event.note} should match chord pcs`);
    }
  });

  it("holds a block for the chord and repeats an arp inside it", () => {
    const project = bar(defaultProject(), 1);
    project.global.phrase = 1;
    project.progression.count = 1;
    project.progression.length = 4;
    project.progression.variation = 0;
    const chordTicks = 16 * 48;
    project.working.chords.rate = modulated(0);
    project.working.chords.tone = modulated(1);
    const block = generatePhrase(project).lanes.chords;
    assert.deepEqual(block.map((event) => event.note), [48, 52, 55]);
    assert.ok(block.every((event) => event.tick === 0 && event.lengthTicks === chordTicks));

    project.working.chords.rate = modulated(0.25);
    project.working.chords.gate = modulated(0.5);
    project.working.chords.tone = modulated(0);
    const arp = generatePhrase(project).lanes.chords;
    assert.ok(arp.every((event) => event.note === 48));
    const step = arp[1].tick - arp[0].tick;
    assert.ok(step > 0);
    assert.ok(arp.length > block.length);
    for (const event of arp) {
      assert.ok(event.lengthTicks <= step);
      assert.ok(event.tick + event.lengthTicks <= chordTicks);
    }
  });

  it("places one short chord note per bar when the generator has one hit", () => {
    const project = defaultProject();
    project.working.chords.gen1.hits = 1;
    const chords = generatePhrase(project).lanes.chords;
    assert.deepEqual(
      chords.map((event) => event.tick),
      [0, 16, 32, 48].map((step) => step * SIXTEENTH_TICKS),
    );
    assert.ok(chords.every((event) => event.lengthTicks < SIXTEENTH_TICKS));
  });

  it("slices a block on the euclid and leaves the rest of the hole quiet", () => {
    const project = bar(defaultProject(), 1);
    project.progression.count = 1;
    project.progression.length = 4;
    project.progression.variation = 0;
    project.working.chords.rate = modulated(0);
    project.working.chords.gen1 = { ...project.working.chords.gen1, length: 16, hits: 4, rotate: 0 };
    project.working.chords.size = modulated(1);
    const held = generatePhrase(project).lanes.chords;
    const quarters = [0, 4, 8, 12].map((step) => step * SIXTEENTH_TICKS);
    for (const tick of quarters) {
      const chord = held.filter((event) => event.tick === tick);
      assert.deepEqual(chord.map((event) => event.note), [48, 52, 55]);
      assert.ok(chord.every((event) => event.lengthTicks === 4 * SIXTEENTH_TICKS));
    }
    assert.equal(held.length, 12);

    project.working.chords.size = modulated(0.5);
    const cut = generatePhrase(project).lanes.chords;
    for (const tick of quarters) {
      const chord = cut.filter((event) => event.tick === tick);
      assert.equal(chord.length, 3);
      assert.ok(chord.every((event) => event.lengthTicks === 3 * SIXTEENTH_TICKS));
    }
    assert.equal(cut.length, 12);

    project.working.chords.gen1 = { ...project.working.chords.gen1, rotate: 2, probability: 1 };
    project.working.chords.size = modulated(1);
    const shifted = generatePhrase(project).lanes.chords;
    for (const step of [2, 6, 10]) {
      const chord = shifted.filter((event) => event.tick === step * SIXTEENTH_TICKS);
      assert.equal(chord.length, 3);
      assert.ok(chord.every((event) => event.lengthTicks === 4 * SIXTEENTH_TICKS));
    }
    const wrapped = shifted.filter((event) => event.tick === 14 * SIXTEENTH_TICKS);
    const tail = shifted.filter((event) => event.tick === 0);
    assert.equal(wrapped.length, 3);
    assert.ok(wrapped.every((event) => event.lengthTicks === 2 * SIXTEENTH_TICKS));
    assert.equal(tail.length, 3);
    assert.ok(tail.every((event) => event.lengthTicks === 2 * SIXTEENTH_TICKS));
  });

  it("does not hand a dropped hit's hole to the previous slice", () => {
    const project = bar(defaultProject(), 1);
    project.progression.count = 1;
    project.progression.length = 4;
    project.progression.variation = 0;
    project.working.chords.rate = modulated(0);
    project.working.chords.size = modulated(1);
    project.working.chords.gen1 = { ...project.working.chords.gen1, length: 16, hits: 4, rotate: 0, probability: 0.5 };
    let found = false;
    for (let seed = 0; seed < 40 && !found; seed++) {
      project.global.seed = seed;
      const notes = generatePhrase(project).lanes.chords;
      const ticks = [...new Set(notes.map((event) => event.tick))];
      if (ticks.length === 0 || ticks.length === 4) continue;
      found = true;
      for (const tick of ticks) {
        const chord = notes.filter((event) => event.tick === tick);
        assert.equal(chord.length, 3);
        assert.ok(chord.every((event) => event.lengthTicks === 4 * SIXTEENTH_TICKS));
      }
    }
    assert.equal(found, true);
    project.working.chords.gen1 = { ...project.working.chords.gen1, probability: 0 };
    assert.equal(generatePhrase(project).lanes.chords.length, 0);
  });

  it("rolls a block once and an arp note by note", () => {
    const project = bar(defaultProject(), 1);
    project.progression.count = 1;
    project.progression.length = 4;
    project.progression.variation = 0;
    project.working.chords.rate = modulated(0);
    project.working.chords.size = modulated(1);
    project.working.chords.gen1 = { ...project.working.chords.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.chords.probability = modulated(0);
    assert.equal(generatePhrase(project).lanes.chords.length, 0);

    project.working.chords.probability = modulated(0.5);
    let thinned = false;
    for (let seed = 0; seed < 40 && !thinned; seed++) {
      project.global.seed = seed;
      const notes = generatePhrase(project).lanes.chords;
      const ticks = [...new Set(notes.map((event) => event.tick))];
      if (ticks.length === 0 || ticks.length === 4) continue;
      thinned = true;
      for (const tick of ticks) assert.equal(notes.filter((event) => event.tick === tick).length, 3);
    }
    assert.equal(thinned, true);

    project.working.chords.gen1 = { ...project.working.chords.gen1, probability: 0 };
    project.working.chords.probability = modulated(1);
    assert.equal(generatePhrase(project).lanes.chords.length, 0);

    const walking = bar(defaultProject(), 2);
    walking.progression.count = 2;
    walking.progression.length = 4;
    walking.progression.variation = 0;
    walking.progression.motion = 1;
    walking.progression.way = 0;
    walking.working.chords.rate = modulated(0);
    walking.working.chords.size = modulated(1);
    walking.working.chords.gen1 = { ...walking.working.chords.gen1, length: 32, hits: 1, rotate: 0, probability: 1 };
    walking.working.chords.probability = modulated(0.5);
    let both = false;
    let neither = false;
    for (let seed = 0; seed < 40 && !(both && neither); seed++) {
      walking.global.seed = seed;
      const notes = generatePhrase(walking).lanes.chords;
      const first = notes.filter((event) => event.tick === 0);
      const second = notes.filter((event) => event.tick === 16 * SIXTEENTH_TICKS);
      assert.equal(first.length === 0, second.length === 0);
      assert.ok(first.length === 0 || first.length === 3);
      if (first.length === 3) both = true;
      if (first.length === 0) neither = true;
    }
    assert.equal(both && neither, true);

    project.working.chords.gen1 = { ...project.working.chords.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.chords.rate = modulated(0.5);
    project.working.chords.gate = modulated(0.5);
    project.working.chords.size = modulated(1);
    project.working.chords.probability = modulated(0);
    assert.equal(generatePhrase(project).lanes.chords.length, 0);
    project.working.chords.probability = modulated(1);
    const full = generatePhrase(project).lanes.chords.length;
    assert.ok(full > 4);
    project.working.chords.probability = modulated(0.5);
    let mixed = false;
    for (let seed = 0; seed < 40 && !mixed; seed++) {
      project.global.seed = seed;
      const count = generatePhrase(project).lanes.chords.length;
      mixed = count > 0 && count < full;
    }
    assert.equal(mixed, true);
  });

  it("draws the rest of a slice that crosses the loop back at the start", () => {
    const project = bar(defaultProject(), 1);
    project.progression.count = 1;
    project.progression.length = 4;
    project.progression.variation = 0;
    project.working.chords.rate = modulated(0);
    project.working.chords.size = modulated(1);
    project.working.chords.gen1 = { ...project.working.chords.gen1, length: 16, hits: 1, rotate: 14 };
    const notes = generatePhrase(project).lanes.chords;
    const attack = notes.filter((event) => event.tick === 14 * SIXTEENTH_TICKS);
    const tail = notes.filter((event) => event.tick === 0);
    assert.equal(attack.length, 3);
    assert.ok(attack.every((event) => event.lengthTicks === 2 * SIXTEENTH_TICKS));
    assert.equal(tail.length, 3);
    assert.ok(tail.every((event) => event.lengthTicks === 14 * SIXTEENTH_TICKS));
  });

  it("pulses only inside the slice and reattacks when the chord changes", () => {
    const project = bar(defaultProject(), 1);
    project.progression.count = 1;
    project.progression.length = 4;
    project.progression.variation = 0;
    project.working.chords.rate = modulated(0.5);
    project.working.chords.gate = modulated(0.5);
    project.working.chords.tone = modulated(0);
    project.working.chords.gen1 = { ...project.working.chords.gen1, length: 16, hits: 2, rotate: 0 };
    project.working.chords.size = modulated(0.25);
    const pulse = generatePhrase(project).lanes.chords;
    const hole = 8 * SIXTEENTH_TICKS;
    const slice = 3 * SIXTEENTH_TICKS;
    assert.ok(pulse.length > 2);
    assert.ok(pulse.every((event) => event.tick % hole < slice));
    assert.ok(pulse.some((event) => event.tick % hole > 0));

    const walking = bar(defaultProject(), 2);
    walking.progression.count = 2;
    walking.progression.length = 4;
    walking.progression.variation = 0;
    walking.progression.motion = 1;
    walking.progression.way = 0;
    walking.working.chords.rate = modulated(0);
    walking.working.chords.size = modulated(1);
    walking.working.chords.gen1 = { ...walking.working.chords.gen1, length: 32, hits: 1, rotate: 0 };
    const notes = generatePhrase(walking).lanes.chords;
    const first = notes.filter((event) => event.tick === 0).map((event) => event.note);
    const second = notes.filter((event) => event.tick === 16 * SIXTEENTH_TICKS).map((event) => event.note);
    assert.equal(first.length, 3);
    assert.equal(second.length, 3);
    assert.notDeepEqual(first, second);
  });

  it("keeps a descending walk inside the selected octave", () => {
    const project = bar(defaultProject(), 1);
    project.global.phrase = 4;
    project.progression.count = 8;
    project.progression.motion = 1;
    project.progression.way = 1;
    project.progression.variation = 0;
    project.working.chords.rate = modulated(0);
    project.progression.tension = 0.5;
    const notes = generatePhrase(project).lanes.chords.map((event) => event.note);
    assert.ok(notes.length > 8);
    const low = Math.min(...notes);
    const high = Math.max(...notes);
    assert.ok(low >= 48 && high <= 59);
    assert.ok(high - low < 12);
  });

  it("rereads rate and gate before the chord ends", () => {
    const project = bar(defaultProject(), 1);
    project.global.phrase = 1;
    project.progression.count = 1;
    project.progression.length = 4;
    project.progression.variation = 0;
    const chordTicks = 16 * 48;
    project.working.chords.rate = modulated(0.5, 2, 16, 0.5);
    project.working.chords.gate = modulated(0.5);
    const mixed = generatePhrase(project).lanes.chords;
    const early = mixed.filter((event) => event.tick < chordTicks / 2);
    const late = mixed.filter((event) => event.tick >= chordTicks / 2);
    assert.ok(new Set(early.map((event) => event.tick)).size > 3);
    assert.ok(early.every((event) => event.lengthTicks < 48));
    assert.equal(new Set(late.map((event) => event.tick)).size, 1);
    assert.deepEqual(late.map((event) => event.note), [48, 52, 55]);
    assert.ok(late.every((event) => event.tick + event.lengthTicks === chordTicks));

    project.working.chords.rate = modulated(0.75);
    project.working.chords.gate = modulated(0.15, 1, 16, 0.8);
    const arp = generatePhrase(project).lanes.chords;
    const short = arp.find((event) => event.tick === 0);
    const later = arp.find((event) => event.tick > chordTicks / 2 && event.tick + event.lengthTicks < chordTicks);
    assert.ok(short && later);
    assert.ok(later.lengthTicks > short.lengthTicks);
  });

  it("picks one chord tone and an octave without moving the bass", () => {
    const project = bar(defaultProject());
    project.working.chords.rate = modulated(1);
    project.working.chords.tone = modulated(0);
    const root = generatePhrase(project);
    project.working.chords.tone = modulated(1);
    const top = generatePhrase(project);
    assert.deepEqual(root.lanes.bass.map((event) => event.note), top.lanes.bass.map((event) => event.note));
    assert.notDeepEqual(root.lanes.chords.map((event) => event.note), top.lanes.chords.map((event) => event.note));
    project.working.chords.tone = modulated(0);
    project.working.chords.octave = modulated(unitForOctave(5));
    const higher = generatePhrase(project);
    assert.equal(higher.lanes.chords.length, root.lanes.chords.length);
    for (let i = 0; i < root.lanes.chords.length; i++) {
      assert.equal(higher.lanes.chords[i]?.note, (root.lanes.chords[i]?.note ?? 0) + 12);
    }
  });

  it("fits chord lengths to the bar grid and shortens passing chords", () => {
    const project = defaultProject();
    project.progression.count = 3;
    project.progression.length = 4;
    project.progression.variation = 0;
    const even = generatePhrase(project).harmony.map((event) => event.lengthTicks / 48);
    assert.equal(even.reduce((sum, length) => sum + length, 0), 64);
    assert.deepEqual(even, [16, 16, 32]);
    project.progression.count = 4;
    project.progression.variation = 3;
    const passed = generatePhrase(project).harmony.map((event) => event.lengthTicks / 48);
    assert.equal(passed.reduce((sum, length) => sum + length, 0), 64);
    assert.ok(Math.min(...passed) < Math.max(...passed));
    for (const length of [...even, ...passed]) assert.equal(length % 4, 0);
  });

  it("places every chord root on the selected key and mode", () => {
    const project = defaultProject();
    project.progression.start = 0;
    project.progression.motion = 1;
    project.progression.way = 0;
    project.progression.count = 7;
    project.progression.variation = 0;
    project.global.phrase = 4;
    project.global.bar = 4;
    project.working.chords.gen1.hits = 1;

    const roots = (scale: ScaleId, root: number, transpose = 0) => {
      project.global.scale = scale;
      project.global.root = root;
      project.global.transpose = transpose;
      const phrase = generatePhrase(project);
      const steps = scaleOf(scale);
      const tonic = ((root + transpose) % 12 + 12) % 12;
      const pcs = phrase.harmony.map((event) => pitchClassOfDegree(event.root, steps, tonic));
      for (const event of phrase.harmony) {
        const pc = pitchClassOfDegree(event.root, steps, tonic);
        const played = phrase.lanes.chords.filter(
          (note) => note.tick >= event.startTick && note.tick < event.startTick + event.lengthTicks,
        );
        assert.ok(played.some((note) => ((note.note % 12) + 12) % 12 === pc), `${scale} chord should sound degree ${event.root}`);
      }
      return pcs;
    };

    assert.deepEqual(roots("minor", 0), [0, 2, 3, 5, 7, 8, 10]);
    assert.deepEqual(roots("major", 0), [0, 2, 4, 5, 7, 9, 11]);
    assert.deepEqual(roots("dorian", 0), [0, 2, 3, 5, 7, 9, 10]);
    assert.deepEqual(roots("mixolydian", 0), [0, 2, 4, 5, 7, 9, 10]);
    assert.deepEqual(roots("minor", 2), [2, 4, 5, 7, 9, 10, 0]);
    assert.deepEqual(roots("minor", 0, 2), roots("minor", 2));
  });

  it("walks repeats along the scale", () => {
    const project = bar(defaultProject());
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 2, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.repeat = modulated(0.4);
    project.working.bass.step = modulated(1);
    project.working.bass.follow = 0;
    project.working.bass.pitch = modulated(0.5);
    const notes = generatePhrase(project).lanes.bass.filter((event) => event.step === 0).map((event) => event.note);
    assert.equal(notes.length, 4);
    assert.deepEqual(notes, [36, 48, 60, 72]);
  });

  it("plays one latched chord for the whole phrase when count is 0", () => {
    resetLatch();
    const project = bar(defaultProject(), 1);
    project.global.phrase = 1;
    project.progression.count = 0;
    project.working.chords.rate = modulated(0);
    assert.equal(generatePhrase(project).harmony.length, 0);
    assert.equal(generatePhrase(project).lanes.chords.length, 0);

    holdNote(0, 60, 100, 0);
    holdNote(1, 64, 100, 10);
    holdNote(0, 67, 80, 20);
    assert.equal(settleLatch(40), false);
    assert.equal(settleLatch(80), true);
    assert.deepEqual(latchedPcs(), [0, 4, 7]);

    const phrase = generatePhrase(project);
    assert.equal(phrase.harmony.length, 1);
    assert.deepEqual(phrase.harmony[0].pcs, [0, 4, 7]);
    assert.equal(phrase.harmony[0].lengthTicks, phrase.steps.chords * 48);
    assert.deepEqual(phrase.lanes.chords.map((event) => event.note).sort((a, b) => a - b), [48, 52, 55]);
    assert.equal(chordLabels(project)[0], "C");
    assert.equal(degreeNumeral(phrase.harmony[0], project.global), "I");

    holdNote(0, 60, 0, 100);
    holdNote(1, 64, 0, 110);
    holdNote(0, 67, 0, 120);
    assert.equal(settleLatch(200), false);
    assert.deepEqual(latchedPcs(), [0, 4, 7]);

    holdNote(0, 62, 100, 300);
    assert.equal(settleLatch(340), false);
    assert.equal(settleLatch(360), true);
    assert.deepEqual(latchedPcs(), [2]);
    assert.equal(chordSymbol(generatePhrase(project).harmony[0], project.global), "D");
    resetLatch();
  });

  it("keeps a note that another channel still holds, and all-notes-off keeps the latch", () => {
    resetLatch();
    holdNote(0, 60, 100, 0);
    holdNote(1, 60, 100, 0);
    holdNote(0, 67, 100, 0);
    assert.equal(settleLatch(50), true);
    assert.deepEqual(latchedPcs(), [0, 7]);
    holdNote(0, 60, 0, 80);
    holdNote(0, 67, 0, 80);
    assert.equal(settleLatch(140), true);
    assert.deepEqual(latchedPcs(), [0]);

    resetLatch();
    holdNote(0, 64, 100, 0);
    holdNote(0, 67, 100, 0);
    holdNote(0, 72, 100, 0);
    assert.equal(settleLatch(50), true);
    assert.deepEqual(latchedPcs(), [0, 4, 7]);

    resetLatch();
    holdNote(0, 60, 100, 0);
    holdNote(0, 64, 100, 0);
    assert.equal(settleLatch(50), true);
    releaseChannel(0, 80);
    assert.equal(settleLatch(200), false);
    assert.deepEqual(latchedPcs(), [0, 4]);
    resetLatch();
  });

  it("lets bass follow latched pitch classes that sit off the scale", () => {
    resetLatch();
    holdNote(0, 60, 100, 0);
    holdNote(0, 64, 100, 0);
    holdNote(0, 67, 100, 0);
    assert.equal(settleLatch(50), true);
    const project = bar(defaultProject());
    project.global.scale = "minor";
    project.progression.count = 0;
    project.working.chords.rate = modulated(0);
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.pitch = modulated(0.5 + 1 / 7);
    project.working.bass.follow = 0;
    const free = generatePhrase(project).lanes.bass[0].note;
    project.working.bass.follow = 1;
    const phrase = generatePhrase(project);
    const pcs = phrase.harmony[0].pcs ?? [];
    assert.deepEqual(pcs, [0, 4, 7]);
    assert.equal(degreeNumeral(phrase.harmony[0], project.global), "I");
    for (const event of phrase.lanes.bass) assert.ok(pcs.includes(((event.note % 12) + 12) % 12));
    assert.notEqual(phrase.lanes.bass[0].note, free);

    resetLatch();
    holdNote(0, 66, 100, 0);
    assert.equal(settleLatch(50), true);
    const named = generatePhrase(project).harmony[0];
    assert.equal(chordSymbol(named, project.global), "F#");
    assert.equal(degreeNumeral(named, project.global), "");
    resetLatch();
  });
});

describe("randomize, wander, sets", () => {
  it("randomizes the pattern half and refuses a locked lane", () => {
    const project = defaultProject();
    const before = clone(project.working.kick.sound);
    const captured = randomizeLane(project, "kick");
    assert.deepEqual(captured.working.kick.sound, before);
    assert.notDeepEqual(captured.working.kick.gen1, project.working.kick.gen1);
    captured.lock.kick = true;
    const again = randomizeLane(captured, "kick");
    assert.equal(again.randomizeNonce, captured.randomizeNonce);
    assert.deepEqual(again.working.kick.gen1, captured.working.kick.gen1);

    const bass = defaultProject();
    const notes = randomizeLane(bass, "bass", "notes");
    assert.notDeepEqual(notes.working.bass.pitch, bass.working.bass.pitch);
    assert.deepEqual(notes.working.bass.gen1, bass.working.bass.gen1);
    assert.deepEqual(notes.working.bass.sound, bass.working.bass.sound);
    const sound = randomizeLane(bass, "kick", "sound");
    assert.notDeepEqual(sound.working.kick.sound, bass.working.kick.sound);
    assert.deepEqual(sound.working.kick.gen1, bass.working.kick.gen1);
    const pattern = randomizeLane(bass, "bass", "pattern");
    assert.notDeepEqual(pattern.working.bass.gen1, bass.working.bass.gen1);
    assert.deepEqual(pattern.working.bass.pitch, bass.working.bass.pitch);
    assert.deepEqual(pattern.working.bass.sound, bass.working.bass.sound);
  });

  it("rerolls pattern, notes and sound together when scope is all", () => {
    const kick = defaultProject();
    const beforeKick = clone(kick.working.kick);
    const allKick = randomizeLane(kick, "kick", "all");
    assert.notDeepEqual(allKick.working.kick.gen1, beforeKick.gen1);
    assert.notDeepEqual(allKick.working.kick.sound, beforeKick.sound);

    const bass = defaultProject();
    const beforeBass = clone(bass.working.bass);
    const allBass = randomizeLane(bass, "bass", "all");
    assert.notDeepEqual(allBass.working.bass.gen1, beforeBass.gen1);
    assert.notDeepEqual(allBass.working.bass.pitch, beforeBass.pitch);
    assert.notDeepEqual(allBass.working.bass.sound, beforeBass.sound);
  });

  it("leaves values, follow and chord scalars when depth is generators", () => {
    const bass = setRandomizeDepth(setRandomizeIntensity(defaultProject(), "hard"), "generators");
    const before = clone(bass.working.bass);
    const notes = randomizeLane(bass, "bass", "notes");
    assert.equal(notes.working.bass.pitch.value, before.pitch.value);
    assert.equal(notes.working.bass.follow, before.follow);
    assert.notDeepEqual(notes.working.bass.pitch, before.pitch);
    const cleared = randomizeLane(setRandomizeIntensity(notes, "clear"), "bass", "notes");
    assert.equal(cleared.working.bass.pitch.value, before.pitch.value);
    assert.equal(cleared.working.bass.pitch.pattern, 0);
    assert.equal(cleared.working.bass.pitch.cycle, 1);
    assert.equal(cleared.working.bass.pitch.amount, 0);
    assert.equal(cleared.working.bass.follow, before.follow);

    const chords = setRandomizeDepth(setRandomizeIntensity(defaultProject(), "hard"), "generators");
    const chordNotes = randomizeLane(chords, "chords", "notes");
    assert.equal(chordNotes.working.chords.tone.value, chords.working.chords.tone.value);
    assert.notDeepEqual(chordNotes.working.chords.tone, chords.working.chords.tone);
    assert.equal(chordNotes.progression.start, chords.progression.start);
  });

  it("moves values and euclid shape but leaves pattern cycle amount when depth is values", () => {
    const bass = setRandomizeDepth(setRandomizeIntensity(defaultProject(), "hard"), "values");
    bass.working.bass.pitch = modulated(0.4, 9, 6, 0.3);
    bass.working.bass.gen1.velocity = modulated(0.7, 4, 5, 0.2);
    const before = clone(bass.working.bass);
    const notes = randomizeLane(bass, "bass", "notes");
    assert.notEqual(notes.working.bass.pitch.value, before.pitch.value);
    assert.equal(notes.working.bass.pitch.pattern, before.pitch.pattern);
    assert.equal(notes.working.bass.pitch.cycle, before.pitch.cycle);
    assert.equal(notes.working.bass.pitch.amount, before.pitch.amount);
    const followed = randomizePaths(bass, "bass", ["follow"]);
    assert.notEqual(followed.working.bass.follow, before.follow);

    const pattern = randomizeLane(bass, "bass", "pattern");
    const shaped =
      pattern.working.bass.gen1.length !== before.gen1.length ||
      pattern.working.bass.gen1.hits !== before.gen1.hits ||
      pattern.working.bass.gen1.rotate !== before.gen1.rotate ||
      pattern.working.bass.gen1.probability !== before.gen1.probability;
    assert.equal(shaped, true);
    assert.equal(pattern.working.bass.gen1.velocity.pattern, before.gen1.velocity.pattern);
    assert.equal(pattern.working.bass.gen1.velocity.cycle, before.gen1.velocity.cycle);
    assert.equal(pattern.working.bass.gen1.velocity.amount, before.gen1.velocity.amount);
    assert.notEqual(pattern.working.bass.gen1.velocity.value, before.gen1.velocity.value);

    const factory = defaultProject().working.bass;
    const cleared = randomizeLane(setRandomizeIntensity(bass, "clear"), "bass", "all");
    assert.equal(cleared.working.bass.pitch.value, factory.pitch.value);
    assert.equal(cleared.working.bass.pitch.pattern, 9);
    assert.equal(cleared.working.bass.pitch.cycle, 6);
    assert.equal(cleared.working.bass.pitch.amount, 0.3);
    assert.equal(cleared.working.bass.follow, factory.follow);
    assert.equal(cleared.working.bass.gen1.length, factory.gen1.length);
    assert.equal(cleared.working.bass.gen1.hits, factory.gen1.hits);
    assert.equal(cleared.working.bass.gen1.velocity.value, factory.gen1.velocity.value);
    assert.equal(cleared.working.bass.gen1.velocity.pattern, 4);
    assert.equal(cleared.working.bass.gen1.velocity.cycle, 5);
    assert.equal(cleared.working.bass.gen1.velocity.amount, 0.2);
    assert.equal(cleared.working.bass.filter.cutoff.value, 0.5);
  });

  it("restores every field on delete when depth is all, and only pattern cycle amount for generators", () => {
    let project = defaultProject();
    project.working.kick.sound.pitch = modulated(0.6, 12, 7, 0.4);
    project.working.kick.gen1.velocity = modulated(0.7, 4, 5, 0.3);
    project.working.kick.gen1.length = 4;
    project.working.kick.gen1.hits = 9;
    project.working.kick.filter.cutoff = modulated(0.1, 3, 8, 0.2);
    project = setRandomizeIntensity(project, "clear");
    const factory = defaultProject().working.kick;
    const cleared = randomizeLane(project, "kick", "all");
    assert.equal(cleared.working.kick.sound.pitch.value, factory.sound.pitch.value);
    assert.equal(cleared.working.kick.sound.pitch.pattern, 0);
    assert.equal(cleared.working.kick.sound.pitch.cycle, 1);
    assert.equal(cleared.working.kick.sound.pitch.amount, 0);
    assert.equal(cleared.working.kick.gen1.length, 16);
    assert.equal(cleared.working.kick.gen1.hits, factory.gen1.hits);
    assert.equal(cleared.working.kick.gen1.rotate, factory.gen1.rotate);
    assert.equal(cleared.working.kick.gen1.probability, 1);
    assert.equal(cleared.working.kick.gen1.velocity.value, factory.gen1.velocity.value);
    assert.equal(cleared.working.kick.gen1.velocity.pattern, 0);
    assert.equal(cleared.working.kick.gen1.velocity.cycle, 1);
    assert.equal(cleared.working.kick.gen1.velocity.amount, 0);
    assert.equal(cleared.working.kick.filter.cutoff.value, 0.5);
    assert.equal(cleared.working.kick.filter.cutoff.amount, 0);
    assert.equal(cleared.working.kick.filter.resonance.value, 0);

    const generators = setRandomizeDepth(project, "generators");
    const partial = randomizeLane(generators, "kick", "all");
    assert.equal(partial.working.kick.gen1.length, 4);
    assert.equal(partial.working.kick.gen1.hits, 9);
    assert.equal(partial.working.kick.gen1.velocity.value, 0.7);
    assert.equal(partial.working.kick.gen1.velocity.pattern, 0);
    assert.equal(partial.working.kick.gen1.velocity.cycle, 1);
    assert.equal(partial.working.kick.gen1.velocity.amount, 0);
    assert.equal(partial.working.kick.sound.pitch.value, 0.6);
    assert.equal(partial.working.kick.sound.pitch.pattern, 0);
    assert.equal(partial.working.kick.sound.pitch.cycle, 1);
    assert.equal(partial.working.kick.sound.pitch.amount, 0);
    assert.equal(partial.working.kick.filter.cutoff.value, 0.1);
    assert.equal(partial.working.kick.filter.cutoff.pattern, 0);
    assert.equal(partial.working.kick.filter.cutoff.cycle, 1);
    assert.equal(partial.working.kick.filter.cutoff.amount, 0);
  });

  it("keeps rerolling values after they have fallen next to home", () => {
    let project = setRandomizeDepth(setRandomizeIntensity(defaultProject(), "medium"), "values");
    const pictures: string[] = [];
    for (let i = 0; i < 40; i++) {
      project = randomizeLane(project, "hat", "sound");
      pictures.push(SOUND.hat.map((id) => Math.round(project.working.hat.sound[id].value * 100)).join(","));
    }
    assert.ok(new Set(pictures.slice(15)).size > 1);

    let parked = setRandomizeIntensity(defaultProject(), "medium");
    parked.working.hat.sound.decay = modulated(0.194, 0, 1, 0);
    let leftGap = false;
    for (let i = 0; i < 12; i++) {
      parked = randomizePaths(parked, "hat", ["sound.decay.value"]);
      const value = parked.working.hat.sound.decay.value;
      if (Math.abs(value - 0.19) < 1e-9 || Math.abs(value - 0.194) >= 0.01 - 1e-9) leftGap = true;
    }
    assert.equal(leftGap, true);
  });

  it("carries a generator value past 10 on a hard roll", () => {
    const hard = setRandomizeIntensity(defaultProject(), "hard");
    let metalHigh = 0;
    let noiseHigh = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const project = { ...hard, global: { ...hard.global, seed }, randomizeNonce: seed };
      const metal = randomizePaths(project, "hat", ["sound.metal.value"]).working.hat.sound.metal.value;
      const noise = randomizePaths(project, "kick", ["sound.noise.value"]).working.kick.sound.noise.value;
      if (metal > 0.2) metalHigh += 1;
      if (noise > 0.2) noiseHigh += 1;
    }
    assert.ok(metalHigh >= 8);
    assert.ok(noiseHigh >= 12);
  });

  it("moves an ordinary value farther than an expensive repeat count", () => {
    const soft = setRandomizeIntensity(defaultProject(), "soft");
    let countTravel = 0;
    let noiseTravel = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const project = {
        ...soft,
        global: { ...soft.global, seed },
        randomizeNonce: seed,
      };
      project.working.kick.ratchet.count = modulated(1, 0, 4, 0);
      project.working.kick.sound.noise = modulated(1, 0, 4, 0);
      const counted = randomizePaths(project, "kick", ["ratchet.count.value"]);
      const noised = randomizePaths(project, "kick", ["sound.noise.value"]);
      countTravel += Math.abs(counted.working.kick.ratchet.count.value - 1);
      noiseTravel += Math.abs(noised.working.kick.sound.noise.value - 1);
    }
    assert.ok(noiseTravel > countTravel);
  });

  it("moves a light pattern farther than a heavy pitch, and toward home farther than away", () => {
    const soft = setRandomizeIntensity(defaultProject(), "soft");
    let pitchTravel = 0;
    let patternTravel = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const project = {
        ...soft,
        global: { ...soft.global, seed },
        randomizeNonce: seed,
      };
      project.working.kick.sound.pitch = modulated(0.9, 48, 1, 0);
      const pitched = randomizePaths(project, "kick", ["sound.pitch.value"]);
      const patterned = randomizePaths(project, "kick", ["sound.pitch.pattern"]);
      pitchTravel += Math.abs(pitched.working.kick.sound.pitch.value - 0.9);
      patternTravel += Math.abs(patterned.working.kick.sound.pitch.pattern - 48) / 63;
    }
    assert.ok(patternTravel > pitchTravel);

    let toward = 0;
    let away = 0;
    let towardN = 0;
    let awayN = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const project = {
        ...soft,
        global: { ...soft.global, seed },
        randomizeNonce: seed,
      };
      project.working.kick.sound.pitch = modulated(0.9, 0, 1, 0);
      const next = randomizePaths(project, "kick", ["sound.pitch.value"]).working.kick.sound.pitch.value;
      const delta = next - 0.9;
      if (delta < -1e-9) {
        toward += -delta;
        towardN += 1;
      } else if (delta > 1e-9) {
        away += delta;
        awayN += 1;
      }
    }
    assert.ok(towardN > 0 && awayN > 0);
    assert.ok(toward / towardN > away / awayN);

    let escaped = false;
    for (let seed = 1; seed <= 40; seed++) {
      const project = {
        ...soft,
        global: { ...soft.global, seed },
        randomizeNonce: seed,
      };
      project.working.kick.sound.noise = modulated(0.4, 0, 1, 0);
      const next = randomizePaths(project, "kick", ["sound.noise.value"]).working.kick.sound.noise.value;
      assert.ok(next <= 0.75 + 1e-9);
      if (next > 0.4 + 1e-9) escaped = true;
    }
    assert.equal(escaped, true);
  });

  it("keeps generator patterns on motif ids at every intensity", () => {
    const patternsOf = (node: unknown, out: number[] = []): number[] => {
      if (!node || typeof node !== "object") return out;
      const record = node as Record<string, unknown>;
      if (typeof record.pattern === "number" && typeof record.cycle === "number" && typeof record.amount === "number") out.push(record.pattern);
      for (const value of Object.values(record)) if (value && typeof value === "object") patternsOf(value, out);
      return out;
    };
    for (const intensity of ["soft", "medium", "hard"] as const) {
      for (const lane of ["kick", "bass", "chords"] as const) {
        for (let seed = 1; seed <= 12; seed++) {
          const project = {
            ...setRandomizeIntensity(defaultProject(), intensity),
            global: { ...defaultProject().global, seed },
            randomizeNonce: seed,
          };
          const next = randomizeLane(project, lane, "all");
          for (const pattern of patternsOf(next.working[lane])) assert.ok(pattern >= 0);
        }
      }
    }

    let leftVoice = false;
    let leftZero = false;
    for (const intensity of ["soft", "medium", "hard"] as const) {
      for (const start of [-7, -1, 0]) {
        for (let seed = 1; seed <= 20; seed++) {
          const project = {
            ...setRandomizeIntensity(defaultProject(), intensity),
            global: { ...defaultProject().global, seed },
            randomizeNonce: seed,
          };
          project.working.lead.filter.cutoff = modulated(0.4, start, 8, -0.25);
          const next = randomizePaths(project, "lead", ["filter.cutoff.pattern"]).working.lead.filter.cutoff;
          assert.ok(next.pattern >= 0);
          assert.equal(next.cycle, 8);
          assert.equal(next.amount, -0.25);
          if (start < 0 && next.pattern !== start) leftVoice = true;
          if (start === 0 && next.pattern > 0) leftZero = true;
        }
      }
    }
    assert.equal(leftVoice, true);
    assert.equal(leftZero, true);
  });

  it("captures only the paths of one page", () => {
    let project = setRandomizeIntensity(defaultProject(), "hard");
    const before = clone(project.working.kick);
    const paths = ["gen1.length", "gen1.hits", "gen1.rotate", "gen1.probability", "gen1.velocity.value"];
    project = randomizePaths(project, "kick", paths);
    assert.notDeepEqual(project.working.kick.gen1, before.gen1);
    assert.deepEqual(project.working.kick.gen2, before.gen2);
    assert.deepEqual(project.working.kick.sound, before.sound);
  });

  it("parks mixer channels at 100 and captures or restores them", () => {
    const fresh = defaultProject();
    for (const id of ["kick", "snare", "hat", "perc", "bass", "lead", "chords", "master"] as const) {
      assert.equal(fresh.mixer[id], 1);
    }
    const project = setRandomizeIntensity(fresh, "hard");
    project.mixer = { ...project.mixer, kick: 0.2, master: 0.2 };
    const moved = randomizeSurface(project, "mix", ["kick"]);
    assert.notEqual(moved.mixer.kick, 0.2);
    assert.equal(moved.mixer.master, 0.2);
    const held = randomizeSurface(setRandomizeDepth(project, "generators"), "mix", ["kick"]);
    assert.equal(held.mixer.kick, 0.2);
    const cleared = randomizeSurface(setRandomizeIntensity(project, "clear"), "mix", ["kick", "master"]);
    assert.equal(cleared.mixer.kick, 1);
    assert.equal(cleared.mixer.master, 1);
    assert.equal(cleared.mixer.snare, 1);
  });

  it("captures the bus when the page is in scope and restores it to zero on delete", () => {
    const project = setRandomizeIntensity(defaultProject(), "hard");
    const paths = ["bus.glue", "bus.pump", "bus.wide", "bus.tilt"];
    const moved = randomizeSurface(project, "bus", paths);
    assert.ok(moved.bus.glue !== 0 || moved.bus.pump !== 0 || moved.bus.wide !== 0 || moved.bus.tilt !== 0);
    const held = randomizeSurface(setRandomizeDepth(project, "generators"), "bus", ["bus.glue"]);
    assert.deepEqual(held.bus, project.bus);
    project.bus = { glue: 0.8, pump: 0.4, wide: 0.6, tilt: -0.5 };
    const cleared = randomizeSurface(setRandomizeIntensity(project, "clear"), "bus", paths);
    assert.deepEqual(cleared.bus, { glue: 0, pump: 0, wide: 0, tilt: 0 });
  });

  it("captures one perf page and zeros a macro on delete", () => {
    const project = setRandomizeIntensity(defaultProject(), "hard");
    project.macros = { probability: 0.8, cutoff: 0.8, noise: 0.8 };
    const page = randomizeSurface(project, "perf", ["macro.probability", "macro.repeat", "macro.rate", "macro.velocity", "macro.cutoff", "macro.resonance", "macro.drive", "macro.decay"]);
    assert.notEqual(page.macros.probability, 0.8);
    assert.equal(page.macros.noise, 0.8);
    const held = randomizeSurface(setRandomizeDepth(project, "generators"), "perf", ["macro.probability"]);
    assert.equal(held.macros.probability, 0.8);
    const cleared = randomizeSurface(setRandomizeIntensity(project, "clear"), "perf", ["macro.cutoff"]);
    assert.equal(cleared.macros.cutoff, 0);
    assert.equal(cleared.macros.probability, 0.8);
  });

  it("writes a macro into lane values on commit and leaves a locked lane", () => {
    const project = defaultProject();
    project.macros = { cutoff: 0.25, decay: 0.25, repeat: 0.25 };
    project.working.bass.filter.cutoff = modulated(0.5, 3, 8, 0.1);
    project.working.snare.filter.cutoff = modulated(0.5);
    project.working.bass.sound.release = modulated(0.25);
    project.working.snare.sound.bodyDecay = modulated(0.25);
    project.working.snare.sound.noiseDecay = modulated(0.25);
    project.working.kick.sound.decay = modulated(0.25);
    project.working.hat.sound.attack = modulated(0.35);
    project.working.bass.repeat = modulated(0.25);
    project.working.lead.repeat = modulated(0.25);
    project.working.kick.ratchet.count = modulated(0.25);
    project.lock.snare = true;
    project.lock.lead = true;
    const heard = generatePhrase(project).lanes.bass[0]?.filter.cutoff;
    const committed = commitMacro(project, "cutoff");
    assert.equal(committed.macros.cutoff, 0);
    assert.equal(committed.macros.decay, 0.25);
    assert.equal(committed.working.bass.filter.cutoff.value, 0.75);
    assert.equal(committed.working.bass.filter.cutoff.pattern, 3);
    assert.equal(committed.working.bass.filter.cutoff.cycle, 8);
    assert.equal(committed.working.bass.filter.cutoff.amount, 0.1);
    assert.equal(committed.working.snare.filter.cutoff.value, 0.5);
    assert.equal(generatePhrase(committed).lanes.bass[0]?.filter.cutoff, heard);
    const tails = commitMacro(committed, "decay");
    assert.equal(tails.macros.decay, 0);
    assert.equal(tails.working.bass.sound.release.value, 0.5);
    assert.equal(tails.working.kick.sound.decay.value, 0.5);
    assert.equal(tails.working.snare.sound.bodyDecay.value, 0.25);
    assert.equal(tails.working.snare.sound.noiseDecay.value, 0.25);
    assert.equal(tails.working.hat.sound.attack.value, 0.35);
    const reps = commitMacro(tails, "repeat");
    assert.equal(reps.working.bass.repeat.value, 0.5);
    assert.equal(reps.working.lead.repeat.value, 0.25);
    assert.equal(reps.working.kick.ratchet.count.value, 0.5);
    assert.equal(commitMacro(reps, "cutoff"), reps);
  });

  it("keeps a committed value when the morph lands", () => {
    let project = setMacro(record(defaultProject()), "cutoff", 0.25);
    project = launchScene(project, "001", 0);
    project = commitMacro(project, "cutoff");
    assert.ok(project.morph?.punched.includes("kick.filter.cutoff.value"));
    const morph = project.morph;
    assert.ok(morph);
    const done = applyMorph(project, morph.originTick + morph.durationTicks);
    assert.equal(done.morph, null);
    assert.equal(done.working.kick.filter.cutoff.value, 0.75);
  });

  it("spends a separate budget on generators and on values", () => {
    const soft = setRandomizeIntensity(defaultProject(), "soft");
    let valueMoves = 0;
    let shapeMoves = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const project = {
        ...soft,
        global: { ...soft.global, seed },
        randomizeNonce: seed,
      };
      project.working.kick.sound.noise = modulated(0.6, 63, 32, 1);
      project.working.kick.sound.pitch = modulated(0.12, 63, 32, 1);
      project.working.kick.sound.decay = modulated(0.1, 63, 32, 1);
      const next = randomizePaths(project, "kick", [
        "sound.noise.value",
        "sound.noise.pattern",
        "sound.noise.cycle",
        "sound.noise.amount",
        "sound.pitch.pattern",
        "sound.pitch.cycle",
        "sound.pitch.amount",
        "sound.decay.pattern",
        "sound.decay.cycle",
        "sound.decay.amount",
      ]).working.kick.sound.noise;
      if (Math.abs(next.value - 0.6) > 1e-9) valueMoves += 1;
      if (next.pattern !== 63 || next.cycle !== 32 || Math.abs(next.amount - 1) > 1e-9) shapeMoves += 1;
    }
    assert.ok(valueMoves >= 30);
    assert.ok(shapeMoves >= 30);
  });

  it("spends a fresh budget on every page of a lane", () => {
    const project = setRandomizeIntensity(defaultProject(), "soft");
    const lane = randomizeLane(project, "kick", "all");
    const page = randomizePaths(project, "kick", ["gen1.length", "gen1.hits", "gen1.rotate", "gen1.probability", "gen1.velocity.value", "gen1.velocity.pattern", "gen1.velocity.cycle", "gen1.velocity.amount"]);
    assert.notDeepEqual(lane.working.kick.sound, project.working.kick.sound);
    assert.deepEqual(page.working.kick.sound, project.working.kick.sound);
    assert.notDeepEqual(lane.working.kick.gen2, project.working.kick.gen2);
    assert.deepEqual(page.working.kick.gen2, project.working.kick.gen2);
    assert.ok(lane.randomizeNonce > page.randomizeNonce);
  });

  it("skips the previous wander target while another scene exists", () => {
    const ids = ["001", "002", "003"];
    for (let salt = 0; salt < 30; salt++) {
      assert.notEqual(pickWanderCandidate(ids, "002", 1, salt), "002");
    }
    assert.equal(pickWanderCandidate(["002"], "002", 1, 4), "002");
  });

  it("removes a journal scene and strips every set link", () => {
    let project = record(defaultProject());
    project = record(project);
    project = createSet(project, "A");
    project = addSceneToSet(project, "set-1", "001");
    project = createSet(project, "B");
    project = addSceneToSet(project, "set-2", "001");
    project = addSceneToSet(project, "set-2", "002");
    project = { ...project, clipboardSceneIds: ["001"], activeSceneId: "001", wanderPreviousTarget: "001" };
    project = removeSceneFromJournal(project, "001");
    assert.deepEqual(
      project.journal.map((scene) => scene.id),
      ["002"],
    );
    assert.deepEqual(project.sets[0].sceneIds, []);
    assert.deepEqual(project.sets[1].sceneIds, ["002"]);
    assert.deepEqual(project.clipboardSceneIds, []);
    assert.equal(project.activeSceneId, null);
    assert.equal(project.wanderPreviousTarget, null);
    const onlySet = removeSceneFromSet(
      { ...defaultProject(), sets: [{ id: "set-1", name: "A", sceneIds: ["001", "002"] }], activeSetId: "set-1", journal: project.journal },
      "set-1",
      "002",
    );
    assert.deepEqual(onlySet.sets[0].sceneIds, ["001"]);
  });

  it("links a recorded scene into the set and keeps one empty set after it", () => {
    const linked = recordInto(defaultProject(), true);
    assert.deepEqual(linked.sets[0].sceneIds, ["001"]);
    assert.deepEqual(linked.sets[1].sceneIds, []);
    assert.equal(linked.activeSetId, "set-1");
    assert.equal(recordInto(defaultProject(), false).sets.length, 0);
  });

  it("pastes marked scenes until the set is full and skips ones already there", () => {
    let project = defaultProject();
    for (let n = 0; n < 3; n++) project = record(project);
    project = createSet(project, "A");
    project = { ...project, clipboardSceneIds: ["001", "002", "001", "003"] };
    project = pasteClipboard(project);
    assert.deepEqual(project.sets[0].sceneIds, ["001", "002", "003"]);
    assert.deepEqual(project.sets.at(-1)?.sceneIds, []);
  });

  it("wanders inside the active set and pages the journal from the newest window", () => {
    let project = defaultProject();
    for (let n = 0; n < 33; n++) project = record(project);
    project = createSet(project, "A");
    project = addSceneToSet(project, project.activeSetId!, "001");
    assert.deepEqual(wanderCandidates(project, "set").filter(Boolean), ["001"]);
    assert.equal(journalPageCount(project.journal.length), 2);
    assert.equal(journalPadIds(project, 0)[0], "002");
    assert.equal(journalPadIds(project, 1)[0], "001");
  });

  it("fills pads from the journal until a set has scenes, and stops at 32", () => {
    let project = defaultProject();
    project = record(project);
    project = record(punch(project, "kick.gen1.velocity.value", 0.4));
    assert.deepEqual(sceneIdsForPads(project), ["001", "002", ...Array(30).fill(null)]);
    project = createSet(project, "A");
    for (let n = 0; n < 40; n++) {
      const id = String(200 + n);
      project.journal.push({ id, lanes: clone(project.working) });
      project = addSceneToSet(project, project.activeSetId!, id);
    }
    assert.equal(project.sets[0].sceneIds.length, 32);
    assert.equal(sceneIdsForPads(project).filter(Boolean).length, 32);
  });

  it("retargets when the wander interval elapses", () => {
    let project = defaultProject();
    project = record(project);
    project = record(punch(project, "kick.gen1.velocity.value", 0));
    project.wander = "fast";
    project.wanderOriginTick = 0;
    project.transition = "now";
    const later = advance(project, 2 * 4 * 192);
    assert.ok(later.wanderPreviousTarget === "001" || later.wanderPreviousTarget === "002");
  });

  it("holds the wander interval after a transition lands", () => {
    let project = defaultProject();
    project = record(project);
    project = record(punch(project, "kick.gen1.velocity.value", 0));
    project.wander = "fast";
    project.transition = "medium";
    project.wanderOriginTick = 0;
    const bar = 4 * 192;
    const gap = 2 * bar;
    const duration = 4 * bar;
    const first = advance(project, gap);
    assert.equal(first.morph?.originTick, gap);
    assert.equal(first.morph?.durationTicks, duration);
    assert.equal(first.wanderOriginTick, gap + duration);
    const overlapped = advance(first, gap + gap);
    assert.equal(overlapped.morph?.originTick, gap);
    assert.equal(overlapped.morph?.targetId, first.morph?.targetId);
    const end = gap + duration;
    const during = advance(overlapped, end - 1);
    assert.equal(during.morph?.originTick, gap);
    const landed = advance(during, end);
    assert.equal(landed.morph, null);
    assert.equal(landed.wanderOriginTick, end);
    const holding = advance(landed, end + gap - 1);
    assert.equal(holding.morph, null);
    assert.equal(holding.activeSceneId, landed.activeSceneId);
    const second = advance(holding, end + gap);
    assert.equal(second.morph?.originTick, end + gap);
    assert.equal(second.wanderOriginTick, end + gap + duration);
    assert.notEqual(second.morph?.targetId, first.morph?.targetId);
  });

  it("starts the wander gap when a running transition ends", () => {
    let project = record(defaultProject());
    project = record(punch(project, "kick.gen1.velocity.value", 0));
    project.transition = "medium";
    project = launchScene(project, "002", 0);
    const bar = 4 * 192;
    const duration = 4 * bar;
    const gap = 2 * bar;
    assert.equal(project.morph?.originTick, 0);
    assert.equal(project.morph?.durationTicks, duration);
    project = { ...project, wander: "fast", wanderOriginTick: 0 };
    const mid = advance(project, duration / 2);
    assert.equal(mid.morph?.originTick, 0);
    assert.equal(mid.morph?.targetId, "002");
    assert.equal(mid.wanderOriginTick, duration);
    const landed = advance(mid, duration);
    assert.equal(landed.morph, null);
    assert.equal(landed.wanderOriginTick, duration);
    const early = advance(landed, duration + gap - 1);
    assert.equal(early.morph, null);
    const next = advance(early, duration + gap);
    assert.equal(next.morph?.originTick, duration + gap);
  });

  it("rolls a non-empty subset of unlocked lanes and falls back to one", () => {
    const project = defaultProject();
    for (const lane of ["kick", "snare", "hat", "perc", "bass", "lead"] as const) {
      project.working[lane].gen1.hits = 1;
      project.working[lane].gen2.hits = 1;
    }
    project.working.chords.gen1.hits = 1;
    project.lock.snare = true;
    project.lock.fx = true;
    const open: PatternId[] = PATTERN_LANES.filter((lane) => lane !== "snare" && lane !== "fx");
    let sawPartial = false;
    let sawFallback = false;
    for (let origin = 0; origin < 512 && !(sawPartial && sawFallback); origin++) {
      const lanes = wanderLanes(project, origin, project.working);
      assert.ok(lanes.length >= 1);
      assert.equal(lanes.includes("snare"), false);
      assert.equal(lanes.includes("fx"), false);
      const coins = open.filter((lane) => hash01(project.global.seed, "wander-lane", origin, lane) < 0.5);
      if (coins.length === 0) {
        assert.equal(lanes.length, 1);
        assert.equal(open.includes(lanes[0]), true);
        sawFallback = true;
      } else {
        assert.deepEqual(lanes, coins);
        if (coins.length < open.length) sawPartial = true;
      }
    }
    assert.equal(sawPartial, true);
    assert.equal(sawFallback, true);
    const held = defaultProject();
    for (const lane of PATTERN_LANES) held.lock[lane] = true;
    assert.deepEqual(wanderLanes(held, 0, held.working), []);
  });

  it("wanders only the rolled lanes, then a pad pulls every unlocked lane", () => {
    const mark = (lane: PatternId) => lane === "fx" ? "fx.reverb.size" : lane === "chords" ? "chords.velocity.value" : `${lane}.gen1.velocity.value`;
    let project = record(defaultProject());
    for (const lane of PATTERN_LANES) project = punch(project, mark(lane), 0.15);
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.lock.hat = true;
    project.wander = "fast";
    project.wanderPreviousTarget = "001";
    project.transition = "now";
    const open = PATTERN_LANES.filter((lane) => lane !== "hat");
    let origin = 0;
    for (; origin < 512; origin++) {
      const lanes = wanderLanes(project, origin, project.working);
      if (lanes.length > 0 && lanes.length < open.length) break;
    }
    const interval = 2 * 4 * 192;
    project.wanderOriginTick = origin - interval;
    const rolled = wanderLanes(project, origin, project.journal[1].lanes);
    assert.ok(rolled.length < open.length);
    const home = project.journal[0].lanes;
    const target = project.journal[1].lanes;
    for (const lane of PATTERN_LANES) assert.notEqual(getPath(home, mark(lane)), getPath(target, mark(lane)), lane);
    const later = advance(project, origin);
    assert.equal(later.morph, null);
    assert.equal(later.wanderPreviousTarget, "002");
    for (const lane of PATTERN_LANES) {
      const path = mark(lane);
      const value = getPath(later.working, path);
      const from = lane === "hat" || !rolled.includes(lane) ? home : target;
      assert.equal(value, getPath(from, path), lane);
    }
    const armed = launchScene(later, "002", origin);
    assert.equal(armed.morph?.lanes, null);
    const pulled = applyMorph(armed, armed.morph?.originTick ?? origin);
    assert.equal(pulled.morph, null);
    for (const lane of PATTERN_LANES) {
      const path = mark(lane);
      const value = getPath(pulled.working, path);
      const from = lane === "hat" ? home : target;
      assert.equal(value, getPath(from, path), lane);
    }
  });

  it("takes a silent destination lane on a fifteen percent coin", () => {
    const project = defaultProject();
    const quiet = clone(project.working);
    quiet.kick.gen1.hits = 0;
    quiet.kick.gen2.hits = 0;
    quiet.snare.gen1.probability = 0;
    quiet.snare.gen2.probability = 0;
    quiet.bass.gen1.hits = 0;
    quiet.bass.gen2.probability = 0;
    quiet.chords.gen1.hits = 0;
    quiet.lead.gen1.length = 0;
    quiet.lead.gen2.length = 0;
    quiet.hat.gen1.hits = 0;
    quiet.hat.gen2.hits = 4;
    const silent = ["kick", "snare", "perc", "bass", "lead", "chords"] as const;
    let sawSilent = false;
    let sawHat = false;
    for (let origin = 0; origin < 64; origin++) {
      const lanes = wanderLanes(project, origin, quiet);
      for (const lane of silent) {
        const take = hash01(project.global.seed, "wander-lane", origin, lane) < 0.15;
        assert.equal(lanes.includes(lane), take);
        if (take) sawSilent = true;
      }
      if (lanes.includes("hat")) sawHat = true;
    }
    assert.equal(sawSilent, true);
    assert.equal(sawHat, true);
    const onlyKick = defaultProject();
    for (const lane of PATTERN_LANES) if (lane !== "kick") onlyKick.lock[lane] = true;
    let movedKick = 0;
    for (let origin = 0; origin < 64; origin++) {
      const take = hash01(onlyKick.global.seed, "wander-lane", origin, "kick") < 0.15;
      assert.deepEqual(wanderLanes(onlyKick, origin, quiet), take ? ["kick"] : []);
      if (take) movedKick++;
    }
    assert.ok(movedKick > 0 && movedKick < 64);

    const mark = (lane: PatternId) => lane === "fx" ? "fx.reverb.size" : lane === "chords" ? "chords.velocity.value" : `${lane}.gen1.velocity.value`;
    let live = record(defaultProject());
    for (const lane of PATTERN_LANES) live = punch(live, mark(lane), 0.15);
    live = punch(live, "kick.gen1.hits", 0);
    live = punch(live, "kick.gen2.hits", 0);
    live = punch(live, "snare.gen1.probability", 0);
    live = punch(live, "snare.gen2.probability", 0);
    live = punch(live, "hat.gen1.hits", 1);
    live = punch(live, "hat.gen2.hits", 1);
    live = record(live);
    const dest = live.journal[1].lanes;
    live.working = clone(live.journal[0].lanes);
    live.wander = "fast";
    live.wanderPreviousTarget = "001";
    live.transition = "now";
    let origin = 0;
    for (; origin < 512; origin++) {
      const kick = hash01(live.global.seed, "wander-lane", origin, "kick") < 0.15;
      const snare = hash01(live.global.seed, "wander-lane", origin, "snare") < 0.15;
      if (wanderLanes(live, origin, dest).includes("hat") && kick && !snare) break;
    }
    assert.ok(origin < 512);
    const interval = 2 * 4 * 192;
    live.wanderOriginTick = origin - interval;
    const home = live.journal[0].lanes;
    const later = advance(live, origin);
    assert.equal(getPath(later.working, mark("kick")), getPath(dest, mark("kick")));
    assert.equal(later.working.kick.gen1.hits, dest.kick.gen1.hits);
    assert.equal(getPath(later.working, mark("snare")), getPath(home, mark("snare")));
    assert.equal(getPath(later.working, mark("hat")), getPath(dest, mark("hat")));
    const armed = launchScene(later, "002", origin);
    const pulled = applyMorph(armed, armed.morph?.originTick ?? origin);
    assert.equal(getPath(pulled.working, mark("kick")), 0.15);
    assert.equal(pulled.working.kick.gen1.hits, 0);
    assert.equal(getPath(pulled.working, mark("snare")), 0.15);
  });

  it("records fx with the scene and glides it, holding a punched knob", () => {
    let project = defaultProject();
    project.working.fx.reverb.size = 0;
    project = record(project);
    assert.equal(project.journal[0].lanes.fx.reverb.size, 0);
    project.working.fx.reverb.size = 1;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "fast";
    project = launchScene(project, "002", 0);
    const duration = project.morph?.durationTicks ?? 0;
    const mid = applyMorph(project, duration / 2);
    assert.ok(Math.abs(mid.working.fx.reverb.size - 0.5) < 1e-6);
    const held = punch(mid, "fx.reverb.size", 0.2);
    const landed = applyMorph(held, duration);
    assert.ok(Math.abs(landed.working.fx.reverb.size - 0.2) < 1e-9);
    assert.equal(landed.morph, null);

    let locked = defaultProject();
    locked.working.fx.reverb.size = 0;
    locked = record(locked);
    locked.working.fx.reverb.size = 1;
    locked = record(locked);
    locked.working = clone(locked.journal[0].lanes);
    locked.lock.fx = true;
    locked.transition = "fast";
    locked = launchScene(locked, "002", 0);
    const stayed = applyMorph(locked, locked.morph?.durationTicks ?? 0);
    assert.equal(stayed.morph, null);
    assert.equal(stayed.working.fx.reverb.size, 0);

    locked.mute.fx = true;
    assert.equal(heardFx(locked).reverb.level, 0);
    assert.equal(locked.working.fx.reverb.level, defaultProject().working.fx.reverb.level);
    const cleared = randomizeLane({ ...locked, lock: { ...locked.lock, fx: false }, randomizeIntensity: "clear" }, "fx", "fx");
    assert.equal(cleared.working.fx.reverb.size, defaultProject().working.fx.reverb.size);
    const heldLock = randomizeLane({ ...locked, randomizeIntensity: "clear" }, "fx", "all");
    assert.equal(heldLock.working.fx.reverb.size, 0);
  });
});

describe("surface catalog", () => {
  it("keeps lane fields, knobs, defaults and engine maps in step", () => {
    const project = defaultProject();
    const fields = fieldsOf(project.working);
    const fieldPaths = new Set(fields.map((field) => field.path));
    for (const lane of PATTERN_LANES) {
      const seen = new Set<string>();
      for (const item of pagesFor(lane)) {
        for (const binding of item.bindings) {
          if (!binding) continue;
          assert.equal(binding.store, "lane");
          const full = `${lane}.${binding.path}`;
          assert.equal(fieldPaths.has(full), true, full);
          assert.equal(typeof getPath(project.working, full), "number");
          assert.equal(bindingFor(binding.path)?.path, binding.path);
          seen.add(full);
        }
      }
      for (const field of fields) {
        if (!field.path.startsWith(`${lane}.`)) continue;
        assert.equal(seen.has(field.path), true, field.path);
        const rel = field.path.slice(lane.length + 1);
        assert.equal(bindingFor(rel)?.morph, field.kind);
      }
      if (lane !== "fx") {
        for (const id of SOUND[lane]) {
          assert.equal(typeof project.working[lane].sound[id]?.value, "number");
          assert.equal(hasSoundMap(lane, id), true);
        }
      }
    }
    const macroKeys = new Set<string>();
    const fed = new Set<string>();
    for (const item of pagesFor("aux")) {
      for (const binding of item.bindings) {
        if (binding?.store === "macro") macroKeys.add(binding.path.slice("macro.".length));
      }
    }
    for (const lane of LANES) {
      for (const item of pagesFor(lane)) {
        for (const binding of item.bindings) {
          for (const key of binding?.macro ?? []) fed.add(key);
        }
      }
    }
    for (const key of macroKeys) assert.equal(fed.has(key), true, key);
    assert.equal(fed.has("count"), true);
    assert.equal(fed.has("reverb"), true);
    assert.equal(fed.has("delay"), true);
    assert.equal(macroOffset("count", { count: 0.2, repeat: 0.3 }), 0.5);
    assert.equal(macroOffset("release", { release: 0.2, decay: 0.3 }), 0.5);
    assert.equal(macroOffset("repeat", { repeat: 0.3 }), 0.3);
    assert.equal(bindingFor("gen1.velocity.value")?.morph, "switch");
    assert.equal(bindingFor("gen1.velocity.amount")?.morph, "switch");
    assert.equal(bindingFor("sound.wave.value")?.morph, "lerp");
    assert.equal(bindingFor("sound.wave.amount")?.morph, "lerp");
    assert.equal(bindingFor("sound.wave.pattern")?.morph, "switch");
    assert.equal(bindingFor("filter.cutoff.value")?.morph, "lerp");
    assert.equal(bindingFor("reverb.size")?.morph, "lerp");
    assert.equal(bindingFor("delay.time")?.morph, "lerp");
    assert.equal(bindingFor("pitch.value")?.morph, "switch");
    assert.equal(bindingFor("follow")?.morph, "switch");
    assert.equal(bindingFor("gen1.length")?.morph, "switch");
    assert.equal(bindingFor("repeat.value")?.weight, 8);
    assert.equal(bindingFor("macro.probability")?.weight, 3);
    assert.equal(bindingFor("follow")?.weight, 6);
    assert.equal(bindingFor("sound.snap.value")?.weight, 2);
    assert.equal(bindingFor("sound.wave.value")?.weight, 1);
    assert.equal(bindingFor("length.value")?.weight, 1);
    assert.equal(bindingFor("gen1.hits")?.weight, 2);
    assert.equal(bindingFor("gen2.hits")?.weight, 2);
    assert.equal(bindingFor("gen1.length")?.weight, 6);
    assert.equal(bindingFor("gen1.length")?.title, "GEN 1 LENGTH");
    assert.equal(bindingFor("follow")?.short, "FOL");
  });
});
