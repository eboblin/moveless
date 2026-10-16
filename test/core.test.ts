import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { sampleOffset, SIXTEENTH_TICKS, unitForIndex } from "../src/core/clock.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { euclidPattern, phraseStepsOf } from "../src/core/events.ts";
import { applyMorph } from "../src/core/morph.ts";
import { motif, MOTIF_COUNT } from "../src/core/motif.ts";
import { modulated } from "../src/core/modulate.ts";
import {
  addSceneToSet,
  advance,
  captureLane,
  captureGenerator,
  capturePaths,
  captureSurface,
  createSet,
  launchScene,
  pickWanderCandidate,
  record,
  removeSceneFromJournal,
  removeSceneFromSet,
  sceneColor,
  sceneIdsForPads,
  setCaptureDepth,
  setCaptureIntensity,
  setMacro,
  audibleEvents,
} from "../src/core/performance.ts";
import { chordOrder, generatePhrase, previewPhrase } from "../src/core/phrase.ts";
import { pitchClassOfDegree, scaleOf } from "../src/core/harmony.ts";
import { chordLabels, textPreview } from "../src/core/text-preview.ts";
import type { ScaleId } from "../src/core/types.ts";
import { punch } from "../src/core/morph.ts";
import type { Project } from "../src/core/types.ts";

function bar(project: Project, bars = 1): Project {
  const next = clone(project);
  const steps = Math.max(1, Math.round(bars)) * Math.max(1, Math.round(next.global.bar)) * 4;
  for (const lane of ["kick", "snare", "hat", "perc", "bass", "lead"] as const) {
    next.working[lane].gen1.length = steps;
    next.working[lane].gen2.length = 0;
  }
  next.global.phrase = bars;
  return next;
}

function modulatedCycles(value: unknown, out: number[] = []): number[] {
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  if (
    typeof record.cycle === "number" &&
    typeof record.value === "number" &&
    typeof record.pattern === "number" &&
    typeof record.amount === "number"
  ) {
    out.push(record.cycle);
    return out;
  }
  for (const child of Object.values(record)) modulatedCycles(child, out);
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
  it("scatters generator homes across hits 2..4 and rotate 0..15", () => {
    const lanes = defaultProject().working;
    const gens = (["kick", "snare", "hat", "perc", "bass", "lead"] as const).flatMap((id) => [
      lanes[id].gen1,
      lanes[id].gen2,
    ]);
    for (const gen of gens) {
      assert.equal(gen.length, 16);
      assert.equal(gen.probability, 1);
      assert.ok(gen.hits >= 2 && gen.hits <= 4);
      assert.ok(gen.rotate >= 0 && gen.rotate <= 15);
    }
    assert.ok(new Set(gens.map((gen) => `${gen.hits}:${gen.rotate}`)).size > 1);
  });

  it("parks repeat count and rate at zero on every lane", () => {
    const lanes = defaultProject().working;
    for (const id of ["kick", "snare", "hat", "perc"] as const) {
      assert.equal(lanes[id].ratchet.count.value, 0);
      assert.equal(lanes[id].ratchet.rate.value, 0);
    }
    assert.equal(lanes.bass.repeat.value, 0);
    assert.equal(lanes.lead.repeat.value, 0);
    assert.equal(lanes.chords.rate.value, 0);
  });

  it("scatters every VPCA cycle across 4, 8 and 16", () => {
    const cycles = modulatedCycles(defaultProject().working);
    assert.ok(cycles.length > 10);
    for (const cycle of cycles) assert.ok(cycle === 4 || cycle === 8 || cycle === 16);
    assert.ok(new Set(cycles).size === 3);
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

  it("matches preview to playback and repeats for the same seed", () => {
    const project = defaultProject();
    assert.deepEqual(previewPhrase(project), generatePhrase(project));
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
  it("lerps velocity and keeps pattern ids until the morph lands", () => {
    let project = defaultProject();
    project = punch(project, "kick.gen1.velocity.value", 0);
    project = punch(project, "kick.ratchet.count.pattern", 2);
    project = record(project);
    project = punch(project, "kick.gen1.velocity.value", 1);
    project = punch(project, "kick.ratchet.count.pattern", 10);
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "fast";
    project = launchScene(project, "002", 0);
    assert.equal(project.morph?.durationTicks, 4 * 192);
    const duration = 4 * 192;
    const mid = applyMorph(project, 376);
    assert.ok(Math.abs(mid.working.kick.gen1.velocity.value - 376 / duration) < 1e-9);
    assert.equal(mid.working.kick.ratchet.count.pattern, 2);
    const half = applyMorph(project, duration / 2);
    assert.equal(half.working.kick.ratchet.count.pattern, 2);
    const heard = generatePhrase(half).lanes.kick;
    assert.ok(heard.length > 0);
    const done = applyMorph(project, 4 * 192);
    assert.equal(done.morph, null);
    assert.equal(done.activeSceneId, "002");
    assert.equal(done.working.kick.gen1.velocity.value, 1);
    assert.equal(done.working.kick.ratchet.count.pattern, 10);
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
    project = record(project);
    project = punch(project, "snare.gen1.velocity.value", 1);
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
    assert.ok(Math.abs(project.working.snare.gen1.velocity.value - 0.25) < 1e-9);
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
    project = punch(project, "bass.sound.cutoff.value", 0.2);
    project = record(project);
    project = punch(project, "bass.sound.cutoff.value", 0.9);
    assert.equal(project.journal[0].lanes.bass.sound.cutoff.value, 0.2);
    assert.equal(project.journal.length, 1);
    assert.equal(project.nextSceneId, 2);
    const heard = generatePhrase(project).lanes.bass[0]?.sound.cutoff;
    assert.equal(project.working.bass.sound.cutoff.value, 0.9);
    assert.ok(heard !== undefined && Math.abs(heard - 1) < 1e-9);
    const saved = generatePhrase({ ...project, working: project.journal[0].lanes, macros: {} }).lanes.bass[0].sound.cutoff;
    assert.ok(Math.abs(saved - 0.2) < 1e-9);
    assert.equal(project.mixer.kick, 0.3);
    project.lock.bass = true;
    const locked = generatePhrase(project).lanes.bass[0].sound.cutoff;
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

  it("blends kick hits across the morph and lands on the target phrase", () => {
    let project = defaultProject();
    project.working.kick.gen1.hits = 4;
    project.working.kick.gen1.rotate = 0;
    project.working.kick.sound.decay.value = 0;
    project.working.kick.sound.decay.amount = 0;
    project.working.chords.start = 0;
    project = record(project);
    project.working.kick.gen1.hits = 7;
    project.working.kick.gen1.rotate = 3;
    project.working.kick.sound.decay.value = 1;
    project.working.kick.sound.decay.amount = 0;
    project.working.chords.start = 3;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "fast";
    project = launchScene(project, "002", 0);
    const duration = project.morph?.durationTicks ?? 0;
    const start = generatePhrase({ ...project, morph: null, working: project.morph!.start });
    const goal = generatePhrase({ ...project, morph: null, working: project.journal[1].lanes });
    const at0 = generatePhrase(project);
    assert.deepEqual(kickSig(at0), kickSig(start));
    assert.deepEqual(at0.harmony.map((event) => event.root), start.harmony.map((event) => event.root));

    const ticks = (phrase: ReturnType<typeof generatePhrase>) => new Set(phrase.lanes.kick.map((event) => event.tick));
    const setA = ticks(start);
    const setB = ticks(goal);
    const onlyA = [...setA].filter((tick) => !setB.has(tick));
    const onlyB = [...setB].filter((tick) => !setA.has(tick));
    const shared = [...setA].filter((tick) => setB.has(tick));
    assert.ok(onlyA.length > 0);
    assert.ok(onlyB.length > 0);
    assert.ok(shared.length > 0);

    const sounding = (tick: number) => ticks(generatePhrase(applyMorph(project, tick)));
    const countOnly = (have: Set<number>, marks: number[]) => marks.filter((tick) => have.has(tick)).length;
    const early = sounding(duration * 0.2);
    const late = sounding(duration * 0.85);
    assert.ok(countOnly(early, onlyA) > countOnly(late, onlyA));
    assert.ok(countOnly(early, onlyB) < countOnly(late, onlyB));
    assert.ok(shared.every((tick) => early.has(tick) && late.has(tick)));

    const left = sounding(duration * 0.49);
    const right = sounding(duration * 0.51);
    let diff = 0;
    for (const tick of left) if (!right.has(tick)) diff += 1;
    for (const tick of right) if (!left.has(tick)) diff += 1;
    assert.ok(diff < setA.size);
    assert.ok([...left].some((tick) => setA.has(tick)));

    const mid = applyMorph(project, duration / 2);
    const changed = generatePhrase(mid).harmony.filter((event, index) => event.root !== start.harmony[index].root).length;
    assert.ok(changed > 0 && changed < start.harmony.length);

    const oneSided = generatePhrase(mid).lanes.kick.find((event) => onlyA.includes(event.tick) || onlyB.includes(event.tick));
    assert.ok(oneSided);
    assert.ok(Math.abs(oneSided.sound.decay - 0.5) < 1e-6);
    assert.notEqual(oneSided.sound.decay, onlyA.includes(oneSided.tick) ? 0 : 1);

    const done = applyMorph(project, duration);
    assert.equal(done.morph, null);
    assert.deepEqual(kickSig(generatePhrase(done)), kickSig(goal));
  });

  it("keeps the drum loop length steady and mixes a one-sided hit's sound", () => {
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
    const duration = project.morph?.durationTicks ?? 0;
    const early = generatePhrase(applyMorph(project, duration * 0.2));
    const late = generatePhrase(applyMorph(project, duration * 0.8));
    assert.equal(early.steps.kick, late.steps.kick);
    assert.ok(early.steps.kick > 16);
    const hit = early.lanes.kick.find((event) => event.tick === 0);
    assert.ok(hit);
    assert.ok(Math.abs(hit.sound.decay - 0.2) < 1e-6);
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

  it("keeps chord and bass peaks within the louder endpoint", () => {
    const blockToBlock = morphPair(
      (project) => {
        project.working.chords.start = 0;
        project.working.chords.rate.value = 0;
      },
      (project) => {
        project.working.chords.start = 4;
        project.working.chords.mood = 1;
        project.working.chords.rate.value = 0;
      },
    );
    assertPeakHeld(blockToBlock, "chords");

    const blockToArp = morphPair(
      (project) => {
        project.working.chords.rate.value = 0;
      },
      (project) => {
        project.working.chords.start = 2;
        project.working.chords.rate.value = 0.45;
        project.working.chords.direction = 1;
      },
    );
    assertPeakHeld(blockToArp, "chords");

    const bassDegree = morphPair(
      () => {},
      (project) => {
        project.working.bass.pitch.value = 0.85;
        project.working.bass.gen1.hits = 5;
      },
    );
    assertPeakHeld(bassDegree, "bass");
  });

  it("pulls repeats and density across lanes without rewriting them", () => {
    const project = defaultProject();
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
    const kickHits = generatePhrase(dense).lanes.kick.length;
    assert.ok(kickHits > 0);
    dense.macros = { probability: -1 };
    assert.equal(generatePhrase(dense).lanes.kick.length, 0);
    assert.equal(dense.working.kick.gen1.probability, 1);
  });
});

function morphPair(setupA: (project: Project) => void, setupB: (project: Project) => void): Project {
  let project = defaultProject();
  setupA(project);
  project = record(project);
  setupB(project);
  project = record(project);
  project.working = clone(project.journal[0].lanes);
  project.transition = "fast";
  return launchScene(project, "002", 0);
}

function assertPeakHeld(project: Project, lane: "chords" | "bass"): void {
  const duration = project.morph?.durationTicks ?? 0;
  const start = peakOverlap(generatePhrase(project), lane);
  const goal = peakOverlap(generatePhrase(applyMorph(project, duration)), lane);
  const cap = Math.max(start, goal);
  for (let i = 1; i < 20; i++) {
    const peak = peakOverlap(generatePhrase(applyMorph(project, (i / 20) * duration)), lane);
    assert.ok(peak <= cap + 1e-6, `${lane} peak ${peak} above ${cap}`);
  }
}

function peakOverlap(phrase: ReturnType<typeof generatePhrase>, lane: "chords" | "bass"): number {
  const events = phrase.lanes[lane];
  const span = Math.max(1, phrase.steps[lane]) * SIXTEENTH_TICKS;
  let peak = 0;
  for (let tick = 0; tick < span; tick += SIXTEENTH_TICKS / 2) {
    let acc = 0;
    for (const event of events) {
      const start = ((event.tick % span) + span) % span;
      const length = Math.max(0, Math.min(event.lengthTicks, span - start));
      if (tick >= start && tick < start + length) acc += event.velocity;
    }
    if (acc > peak) peak = acc;
  }
  return peak;
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
    project.working.chords.mood = 0;
    project.working.chords.tension = 0;
    const followed = generatePhrase(project).lanes.bass[0].note;
    project.working.bass.follow = 0;
    const free = generatePhrase(project).lanes.bass[0].note;
    assert.equal(followed, 24);
    assert.equal(free, 26);
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
    project.working.chords.mood = 0;
    project.working.chords.tension = 0;
    project.working.chords.count = 1;
    project.working.bass.follow = 1;
    project.working.bass.pitch = modulated(0.5 + 1 / 7);
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 4, rotate: 0 };
    project.working.bass.gen2.hits = 0;
    const phrase = generatePhrase(project);
    const chordPcs = new Set(phrase.lanes.chords.map((event) => ((event.note % 12) + 12) % 12));
    assert.ok(chordPcs.has(4), "maj chord in minor still sounds E");
    for (const event of phrase.lanes.bass) {
      assert.ok(chordPcs.has(((event.note % 12) + 12) % 12), `bass ${event.note} should match chord pcs`);
    }
  });

  it("orders chord tones up, down, across, and back through the chord", () => {
    const notes = [48, 52, 55];
    assert.deepEqual(chordOrder(notes, 0, 0, 1), [48, 52, 55]);
    assert.deepEqual(chordOrder(notes, 1, 0, 1), [55, 52, 48]);
    assert.deepEqual(chordOrder(notes, 2, 0, 1), [48, 52, 55]);
    assert.deepEqual(chordOrder(notes, 2, 1, 1), [55, 52, 48]);
    assert.deepEqual(chordOrder(notes, 3, 0, 1), [48, 52, 55, 52]);
    assert.deepEqual(chordOrder(notes, 4, 0, 1), [55, 52, 48, 52]);
    assert.deepEqual(chordOrder(notes, 5, 0, 1), [48, 55, 52]);
    assert.deepEqual(chordOrder(notes, 6, 0, 1), [52, 55, 48]);
    assert.deepEqual(chordOrder(notes, 7, 0, 1), chordOrder(notes, 7, 0, 1));
    const again = chordOrder(notes, 7, 0, 1).join();
    assert.ok([2, 3, 4, 5, 6, 7, 8, 9].some((seed) => chordOrder(notes, 7, 0, seed).join() !== again));
  });

  it("holds a block for the chord and repeats an arp inside it", () => {
    const project = bar(defaultProject(), 1);
    project.global.phrase = 1;
    project.working.chords.count = 1;
    project.working.chords.length = 4;
    project.working.chords.variation = 0;
    project.working.chords.octaves = 1;
    project.working.chords.direction = 0;
    const chordTicks = 16 * 48;
    project.working.chords.rate = modulated(0);
    const block = generatePhrase(project).lanes.chords;
    assert.ok(block.length >= 3);
    assert.ok(block.every((event) => event.tick === 0 && event.lengthTicks === chordTicks));

    project.working.chords.rate = modulated(0.25);
    project.working.chords.gate = modulated(0.5);
    const arp = generatePhrase(project).lanes.chords;
    const step = arp[1].tick - arp[0].tick;
    assert.ok(step > 0);
    assert.ok(arp.length > block.length);
    for (const event of arp) {
      assert.ok(event.lengthTicks <= step);
      assert.ok(event.tick + event.lengthTicks <= chordTicks);
    }
  });

  it("rereads rate and gate before the chord ends", () => {
    const project = bar(defaultProject(), 1);
    project.global.phrase = 1;
    project.working.chords.count = 1;
    project.working.chords.length = 4;
    project.working.chords.variation = 0;
    project.working.chords.octaves = 1;
    project.working.chords.direction = 0;
    const chordTicks = 16 * 48;
    project.working.chords.rate = modulated(0.5, 2, 16, 0.5);
    project.working.chords.gate = modulated(0.5);
    const mixed = generatePhrase(project).lanes.chords;
    const early = mixed.filter((event) => event.tick < chordTicks / 2);
    const late = mixed.filter((event) => event.tick >= chordTicks / 2);
    assert.ok(new Set(early.map((event) => event.tick)).size > 3);
    assert.ok(early.every((event) => event.lengthTicks < 48));
    assert.equal(new Set(late.map((event) => event.tick)).size, 1);
    assert.ok(late.length >= 3);
    assert.ok(late.every((event) => event.tick + event.lengthTicks === chordTicks));

    project.working.chords.rate = modulated(0.75);
    project.working.chords.gate = modulated(0.15, 1, 16, 0.8);
    const arp = generatePhrase(project).lanes.chords;
    const short = arp.find((event) => event.tick === 0);
    const later = arp.find((event) => event.tick > chordTicks / 2 && event.tick + event.lengthTicks < chordTicks);
    assert.ok(short && later);
    assert.ok(later.lengthTicks > short.lengthTicks);
  });

  it("keeps bass notes stable when the arp direction changes", () => {
    const project = bar(defaultProject());
    project.working.chords.rate = modulated(1);
    const up = generatePhrase(project);
    project.working.chords.direction = 1;
    const down = generatePhrase(project);
    assert.deepEqual(up.lanes.bass.map((event) => event.note), down.lanes.bass.map((event) => event.note));
    assert.notDeepEqual(up.lanes.chords.map((event) => event.note), down.lanes.chords.map((event) => event.note));
  });

  it("fits chord lengths to the bar grid and shortens passing chords", () => {
    const project = defaultProject();
    project.working.chords.count = 3;
    project.working.chords.length = 4;
    project.working.chords.variation = 0;
    const even = generatePhrase(project).harmony.map((event) => event.lengthTicks / 48);
    assert.equal(even.reduce((sum, length) => sum + length, 0), 64);
    assert.deepEqual(even, [16, 16, 32]);
    project.working.chords.count = 4;
    project.working.chords.variation = 3;
    const passed = generatePhrase(project).harmony.map((event) => event.lengthTicks / 48);
    assert.equal(passed.reduce((sum, length) => sum + length, 0), 64);
    assert.ok(Math.min(...passed) < Math.max(...passed));
    for (const length of [...even, ...passed]) assert.equal(length % 4, 0);
  });

  it("places every chord root on the selected key and mode", () => {
    const project = defaultProject();
    project.working.chords.start = 0;
    project.working.chords.motion = 1;
    project.working.chords.way = 0;
    project.working.chords.count = 7;
    project.working.chords.variation = 0;
    project.global.phrase = 4;
    project.global.bar = 4;

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
    assert.deepEqual(notes, [24, 36, 48, 60]);
  });
});

describe("capture, wander, sets", () => {
  it("randomizes the pattern half and refuses a locked lane", () => {
    const project = defaultProject();
    const before = clone(project.working.kick.sound);
    const captured = captureLane(project, "kick");
    assert.deepEqual(captured.working.kick.sound, before);
    assert.notDeepEqual(captured.working.kick.gen1, project.working.kick.gen1);
    captured.lock.kick = true;
    const again = captureLane(captured, "kick");
    assert.equal(again.captureNonce, captured.captureNonce);
    assert.deepEqual(again.working.kick.gen1, captured.working.kick.gen1);

    const bass = defaultProject();
    const notes = captureLane(bass, "bass", "notes");
    assert.notDeepEqual(notes.working.bass.pitch, bass.working.bass.pitch);
    assert.deepEqual(notes.working.bass.gen1, bass.working.bass.gen1);
    assert.deepEqual(notes.working.bass.sound, bass.working.bass.sound);
    const sound = captureLane(bass, "kick", "sound");
    assert.notDeepEqual(sound.working.kick.sound, bass.working.kick.sound);
    assert.deepEqual(sound.working.kick.gen1, bass.working.kick.gen1);
    const pattern = captureLane(bass, "bass", "pattern");
    assert.notDeepEqual(pattern.working.bass.gen1, bass.working.bass.gen1);
    assert.deepEqual(pattern.working.bass.pitch, bass.working.bass.pitch);
    assert.deepEqual(pattern.working.bass.sound, bass.working.bass.sound);
  });

  it("rerolls pattern, notes and sound together when scope is all", () => {
    const kick = defaultProject();
    const beforeKick = clone(kick.working.kick);
    const allKick = captureLane(kick, "kick", "all");
    assert.notDeepEqual(allKick.working.kick.gen1, beforeKick.gen1);
    assert.notDeepEqual(allKick.working.kick.sound, beforeKick.sound);

    const bass = defaultProject();
    const beforeBass = clone(bass.working.bass);
    const allBass = captureLane(bass, "bass", "all");
    assert.notDeepEqual(allBass.working.bass.gen1, beforeBass.gen1);
    assert.notDeepEqual(allBass.working.bass.pitch, beforeBass.pitch);
    assert.notDeepEqual(allBass.working.bass.sound, beforeBass.sound);
  });

  it("leaves values, follow and chord scalars when depth is generators", () => {
    const bass = setCaptureDepth(setCaptureIntensity(defaultProject(), "hard"), "generators");
    const before = clone(bass.working.bass);
    const notes = captureLane(bass, "bass", "notes");
    assert.equal(notes.working.bass.pitch.value, before.pitch.value);
    assert.equal(notes.working.bass.follow, before.follow);
    assert.notDeepEqual(notes.working.bass.pitch, before.pitch);
    const cleared = captureLane(setCaptureIntensity(bass, "clear"), "bass", "notes");
    assert.equal(cleared.working.bass.pitch.value, before.pitch.value);
    assert.equal(cleared.working.bass.pitch.pattern, 0);
    assert.equal(cleared.working.bass.pitch.cycle, 0);
    assert.equal(cleared.working.bass.pitch.amount, 0);
    assert.equal(cleared.working.bass.follow, before.follow);

    const chords = setCaptureDepth(setCaptureIntensity(defaultProject(), "hard"), "generators");
    const chordNotes = captureLane(chords, "chords", "notes");
    assert.equal(chordNotes.working.chords.start, chords.working.chords.start);
    assert.equal(chordNotes.working.chords.count, chords.working.chords.count);
  });

  it("moves values and euclid shape but leaves pattern cycle amount when depth is values", () => {
    const bass = setCaptureDepth(setCaptureIntensity(defaultProject(), "hard"), "values");
    bass.working.bass.pitch = modulated(0.4, 9, 6, 0.3);
    bass.working.bass.gen1.velocity = modulated(0.7, 4, 5, 0.2);
    const before = clone(bass.working.bass);
    const notes = captureLane(bass, "bass", "notes");
    assert.notEqual(notes.working.bass.pitch.value, before.pitch.value);
    assert.equal(notes.working.bass.pitch.pattern, before.pitch.pattern);
    assert.equal(notes.working.bass.pitch.cycle, before.pitch.cycle);
    assert.equal(notes.working.bass.pitch.amount, before.pitch.amount);
    const followed = capturePaths(bass, "bass", ["follow"]);
    assert.notEqual(followed.working.bass.follow, before.follow);

    const pattern = captureLane(bass, "bass", "pattern");
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

    const cleared = captureLane(setCaptureIntensity(bass, "clear"), "bass", "all");
    assert.equal(cleared.working.bass.pitch.value, 0);
    assert.equal(cleared.working.bass.pitch.pattern, 9);
    assert.equal(cleared.working.bass.pitch.cycle, 6);
    assert.equal(cleared.working.bass.pitch.amount, 0.3);
    assert.equal(cleared.working.bass.follow, 0);
    assert.equal(cleared.working.bass.gen1.length, 0);
    assert.equal(cleared.working.bass.gen1.velocity.value, 0);
    assert.equal(cleared.working.bass.gen1.velocity.pattern, 4);
    assert.equal(cleared.working.bass.gen1.velocity.cycle, 5);
    assert.equal(cleared.working.bass.gen1.velocity.amount, 0.2);
  });

  it("rerolls one generator and leaves the rest of the lane", () => {
    const project = defaultProject();
    const one = captureGenerator(project, "kick", "gen1");
    assert.notDeepEqual(one.working.kick.gen1, project.working.kick.gen1);
    assert.deepEqual(one.working.kick.gen2, project.working.kick.gen2);
    assert.deepEqual(one.working.kick.ratchet, project.working.kick.ratchet);
    assert.deepEqual(one.working.kick.sound, project.working.kick.sound);
    const hard = setCaptureIntensity(project, "hard");
    const count = captureGenerator(hard, "kick", "ratchet.count");
    assert.notDeepEqual(count.working.kick.ratchet.count, hard.working.kick.ratchet.count);
    assert.deepEqual(count.working.kick.ratchet.rate, hard.working.kick.ratchet.rate);
    const pitch = captureGenerator(project, "kick", "sound.pitch");
    assert.notDeepEqual(pitch.working.kick.sound.pitch, project.working.kick.sound.pitch);
    assert.deepEqual(pitch.working.kick.sound.tone, project.working.kick.sound.tone);
    pitch.lock.kick = true;
    const locked = captureGenerator(pitch, "kick", "gen1");
    assert.equal(locked.captureNonce, pitch.captureNonce);
    assert.deepEqual(locked.working.kick.gen1, pitch.working.kick.gen1);
  });

  it("zeros every field on delete when depth is all, and only cycle pattern amount for generators", () => {
    let project = defaultProject();
    project.working.kick.sound.pitch = modulated(0.6, 12, 7, 0.4);
    project.working.kick.gen1.velocity = modulated(0.7, 4, 5, 0.3);
    project = setCaptureIntensity(project, "clear");
    const cleared = captureLane(project, "kick", "all");
    assert.equal(cleared.working.kick.sound.pitch.value, 0);
    assert.equal(cleared.working.kick.sound.pitch.pattern, 0);
    assert.equal(cleared.working.kick.sound.pitch.cycle, 0);
    assert.equal(cleared.working.kick.sound.pitch.amount, 0);
    assert.equal(cleared.working.kick.gen1.length, 0);
    assert.equal(cleared.working.kick.gen1.hits, 0);
    assert.equal(cleared.working.kick.gen1.rotate, 0);
    assert.equal(cleared.working.kick.gen1.probability, 0);
    assert.equal(cleared.working.kick.gen1.velocity.value, 0);
    assert.equal(cleared.working.kick.gen1.velocity.cycle, 0);

    const generators = setCaptureDepth(project, "generators");
    const shape = generators.working.kick.gen1.length;
    const partial = captureLane(generators, "kick", "all");
    assert.equal(partial.working.kick.gen1.length, shape);
    assert.equal(partial.working.kick.gen1.velocity.value, 0.7);
    assert.equal(partial.working.kick.gen1.velocity.pattern, 0);
    assert.equal(partial.working.kick.gen1.velocity.cycle, 0);
    assert.equal(partial.working.kick.gen1.velocity.amount, 0);
    assert.equal(partial.working.kick.sound.pitch.value, 0.6);
    assert.equal(partial.working.kick.sound.pitch.pattern, 0);
    assert.equal(partial.working.kick.sound.pitch.cycle, 0);
    assert.equal(partial.working.kick.sound.pitch.amount, 0);
  });

  it("moves an ordinary value farther than an expensive repeat count", () => {
    const soft = setCaptureIntensity(defaultProject(), "soft");
    let countTravel = 0;
    let noiseTravel = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const project = {
        ...soft,
        global: { ...soft.global, seed },
        captureNonce: seed,
      };
      project.working.kick.ratchet.count = modulated(1, 0, 4, 0);
      project.working.kick.sound.noise = modulated(1, 0, 4, 0);
      const counted = capturePaths(project, "kick", ["ratchet.count.value"]);
      const noised = capturePaths(project, "kick", ["sound.noise.value"]);
      countTravel += Math.abs(counted.working.kick.ratchet.count.value - 1);
      noiseTravel += Math.abs(noised.working.kick.sound.noise.value - 1);
    }
    assert.ok(noiseTravel > countTravel);
  });

  it("moves a light pattern farther than a heavy pitch, and toward home farther than away", () => {
    const soft = setCaptureIntensity(defaultProject(), "soft");
    let pitchTravel = 0;
    let patternTravel = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const project = {
        ...soft,
        global: { ...soft.global, seed },
        captureNonce: seed,
      };
      project.working.kick.sound.pitch = modulated(0.9, 48, 1, 0);
      const pitched = capturePaths(project, "kick", ["sound.pitch.value"]);
      const patterned = capturePaths(project, "kick", ["sound.pitch.pattern"]);
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
        captureNonce: seed,
      };
      project.working.kick.sound.pitch = modulated(0.9, 0, 1, 0);
      const next = capturePaths(project, "kick", ["sound.pitch.value"]).working.kick.sound.pitch.value;
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
  });

  it("captures only the paths of one page", () => {
    let project = setCaptureIntensity(defaultProject(), "hard");
    const before = clone(project.working.kick);
    const paths = ["gen1.length", "gen1.hits", "gen1.rotate", "gen1.probability", "gen1.velocity.value"];
    project = capturePaths(project, "kick", paths);
    assert.notDeepEqual(project.working.kick.gen1, before.gen1);
    assert.deepEqual(project.working.kick.gen2, before.gen2);
    assert.deepEqual(project.working.kick.sound, before.sound);
  });

  it("parks mixer channels at 100 and captures or zeros them", () => {
    const fresh = defaultProject();
    for (const id of ["kick", "snare", "hat", "perc", "bass", "lead", "chords", "master"] as const) {
      assert.equal(fresh.mixer[id], 1);
    }
    const project = setCaptureIntensity(fresh, "hard");
    project.mixer = { ...project.mixer, kick: 0.2, master: 0.2 };
    const moved = captureSurface(project, "mix", ["kick"]);
    assert.notEqual(moved.mixer.kick, 0.2);
    assert.equal(moved.mixer.master, 0.2);
    const held = captureSurface(setCaptureDepth(project, "generators"), "mix", ["kick"]);
    assert.equal(held.mixer.kick, 0.2);
    const cleared = captureSurface(setCaptureIntensity(project, "clear"), "mix", ["kick", "master"]);
    assert.equal(cleared.mixer.kick, 0);
    assert.equal(cleared.mixer.master, 0);
    assert.equal(cleared.mixer.snare, 1);
  });

  it("captures one perf page and zeros a macro on delete", () => {
    const project = setCaptureIntensity(defaultProject(), "hard");
    project.macros = { probability: 0.8, cutoff: 0.8 };
    const page = captureSurface(project, "perf", ["macro.probability", "macro.repeat", "macro.step", "macro.velocity", "macro.length", "macro.gate", "macro.rate", "macro.decay"]);
    assert.notEqual(page.macros.probability, 0.8);
    assert.equal(page.macros.cutoff, 0.8);
    const held = captureSurface(setCaptureDepth(project, "generators"), "perf", ["macro.probability"]);
    assert.equal(held.macros.probability, 0.8);
    const cleared = captureSurface(setCaptureIntensity(project, "clear"), "perf", ["macro.cutoff"]);
    assert.equal(cleared.macros.cutoff, 0);
    assert.equal(cleared.macros.probability, 0.8);
  });

  it("spends a fresh budget on every page of a lane", () => {
    const project = setCaptureIntensity(defaultProject(), "soft");
    const lane = captureLane(project, "kick", "all");
    const page = capturePaths(project, "kick", ["gen1.length", "gen1.hits", "gen1.rotate", "gen1.probability", "gen1.velocity.value", "gen1.velocity.pattern", "gen1.velocity.cycle", "gen1.velocity.amount"]);
    assert.notDeepEqual(lane.working.kick.sound, project.working.kick.sound);
    assert.deepEqual(page.working.kick.sound, project.working.kick.sound);
    assert.notDeepEqual(lane.working.kick.gen2, project.working.kick.gen2);
    assert.deepEqual(page.working.kick.gen2, project.working.kick.gen2);
    assert.ok(lane.captureNonce > page.captureNonce);
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
    project = { ...project, clipboardSceneId: "001", activeSceneId: "001", wanderPreviousTarget: "001" };
    project = removeSceneFromJournal(project, "001");
    assert.deepEqual(
      project.journal.map((scene) => scene.id),
      ["002"],
    );
    assert.deepEqual(project.sets[0].sceneIds, []);
    assert.deepEqual(project.sets[1].sceneIds, ["002"]);
    assert.equal(project.clipboardSceneId, null);
    assert.equal(project.activeSceneId, null);
    assert.equal(project.wanderPreviousTarget, null);
    const onlySet = removeSceneFromSet(
      { ...defaultProject(), sets: [{ id: "set-1", name: "A", sceneIds: ["001", "002"] }], activeSetId: "set-1", journal: project.journal },
      "set-1",
      "002",
    );
    assert.deepEqual(onlySet.sets[0].sceneIds, ["001"]);
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
});
