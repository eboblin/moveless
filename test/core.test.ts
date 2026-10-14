import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { sampleOffset, unitForIndex } from "../src/core/clock.ts";
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
  createSet,
  cycleBiased,
  launchScene,
  pickWanderCandidate,
  record,
  removeSceneFromJournal,
  removeSceneFromSet,
  sceneColor,
  sceneIdsForPads,
  setCaptureIntensity,
  setMacro,
  audibleEvents,
} from "../src/core/performance.ts";
import { chordOrder, generatePhrase, previewPhrase } from "../src/core/phrase.ts";
import { chordLabels, textPreview } from "../src/core/text-preview.ts";
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
  it("places a four-on-the-floor kick on every fourth sixteenth", () => {
    const project = bar(defaultProject());
    const line = textPreview(project).split("\n")[0];
    assert.equal(line, "KCK x---x---x---x---");
  });

  it("unions a second generator without stacking two events on one step", () => {
    const project = bar(defaultProject());
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
    project.working.kick.ratchet.count = modulated(0.4);
    project.working.kick.ratchet.rate = modulated(unitForIndex(1, 6));
    const ticks = generatePhrase(project).lanes.kick.filter((event) => event.step === 0).map((event) => event.tick);
    assert.deepEqual(ticks, [0, 48, 96, 144]);
  });

  it("reads a modulator at the note time rather than the note count", () => {
    const project = bar(defaultProject());
    project.working.kick.sound.pitch = modulated(0.5, 0, 16, 1);
    const kicks = generatePhrase(project).lanes.kick;
    const at = (step: number) => kicks.find((event) => event.step === step)?.sound.pitch;
    assert.equal(at(0), 0.5);
    assert.equal(at(4), 1);
  });

  it("delays odd sixteenths with swing and keeps block offsets in range", () => {
    const project = bar(defaultProject());
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
  it("lerps velocity and switches pattern ids at one half", () => {
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
    assert.equal(half.working.kick.ratchet.count.pattern, 10);
    const done = applyMorph(project, 4 * 192);
    assert.equal(done.morph, null);
    assert.equal(done.activeSceneId, "002");
    assert.equal(done.working.kick.gen1.velocity.value, 1);
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
});

describe("harmony", () => {
  it("publishes chord context that bass can follow, including when chords are muted", () => {
    const project = bar(defaultProject());
    project.working.bass.degree = modulated(0.5 + 1 / 14);
    project.working.bass.range = modulated(1);
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
    project.working.bass.degree = modulated(0.5 + 2 / 14);
    project.working.bass.range = modulated(1);
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

  it("walks repeats along the scale", () => {
    const project = bar(defaultProject());
    project.working.bass.repeat = modulated(0.4);
    project.working.bass.step = modulated(1);
    project.working.bass.follow = 0;
    project.working.bass.degree = modulated(0.5);
    project.working.bass.range = modulated(1);
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
    assert.notDeepEqual(notes.working.bass.degree, bass.working.bass.degree);
    assert.deepEqual(notes.working.bass.gen1, bass.working.bass.gen1);
    assert.deepEqual(notes.working.bass.sound, bass.working.bass.sound);
    const sound = captureLane(bass, "kick", "sound");
    assert.notDeepEqual(sound.working.kick.sound, bass.working.kick.sound);
    assert.deepEqual(sound.working.kick.gen1, bass.working.kick.gen1);
    const pattern = captureLane(bass, "bass", "pattern");
    assert.notDeepEqual(pattern.working.bass.gen1, bass.working.bass.gen1);
    assert.deepEqual(pattern.working.bass.degree, bass.working.bass.degree);
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
    assert.notDeepEqual(allBass.working.bass.degree, beforeBass.degree);
    assert.notDeepEqual(allBass.working.bass.sound, beforeBass.sound);
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

  it("clears modulation but leaves value and cycle", () => {
    let project = defaultProject();
    project.working.kick.sound.pitch = modulated(0.6, 12, 7, 0.4);
    project = setCaptureIntensity(project, "clear");
    const cleared = captureGenerator(project, "kick", "sound.pitch");
    assert.equal(cleared.working.kick.sound.pitch.value, 0.6);
    assert.equal(cleared.working.kick.sound.pitch.cycle, 7);
    assert.equal(cleared.working.kick.sound.pitch.pattern, 0);
    assert.equal(cleared.working.kick.sound.pitch.amount, 0);
    assert.deepEqual(cleared.working.kick.gen1, project.working.kick.gen1);
  });

  it("biases rerolled cycles toward 4 and keeps soft P/C/A rare", () => {
    const hist = Array.from({ length: 9 }, () => 0);
    for (let i = 0; i < 800; i++) hist[cycleBiased((i + 0.5) / 800)]++;
    assert.ok(hist[4] > hist[1]);
    assert.ok(hist[4] > hist[8]);
    assert.ok(hist[4] >= hist[3]);
    assert.ok(hist[4] >= hist[5]);

    let project = defaultProject();
    project.working.kick.sound.pitch = modulated(0.5, 10, 2, 0.3);
    project = setCaptureIntensity(project, "soft");
    let patternFlips = 0;
    let cycleFlips = 0;
    let amountFlips = 0;
    for (let n = 0; n < 40; n++) {
      project = { ...project, captureNonce: n, global: { ...project.global, seed: n + 1 } };
      const next = captureGenerator(project, "kick", "sound.pitch");
      if (next.working.kick.sound.pitch.pattern !== 10) patternFlips++;
      if (next.working.kick.sound.pitch.cycle !== 2) cycleFlips++;
      if (next.working.kick.sound.pitch.amount !== 0.3) amountFlips++;
    }
    assert.ok(patternFlips < 20);
    assert.ok(cycleFlips < 20);
    assert.ok(amountFlips < 20);

    project = setCaptureIntensity(defaultProject(), "hard");
    project.working.kick.sound.pitch = modulated(0.5, 10, 2, 0.3);
    let hardFlips = 0;
    for (let n = 0; n < 40; n++) {
      project = { ...project, captureNonce: n, global: { ...project.global, seed: n + 3 } };
      const next = captureGenerator(project, "kick", "sound.pitch");
      if (
        next.working.kick.sound.pitch.pattern !== 10 ||
        next.working.kick.sound.pitch.cycle !== 2 ||
        next.working.kick.sound.pitch.amount !== 0.3
      ) {
        hardFlips++;
      }
    }
    assert.ok(hardFlips > 20);
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

  it("nudges one euclid structure field on soft capture", () => {
    let project = setCaptureIntensity(defaultProject(), "soft");
    project.working.kick.gen1 = { length: 16, hits: 4, rotate: 2, probability: 0.8, velocity: modulated(0.7) };
    const before = clone(project.working.kick.gen1);
    project = captureGenerator(project, "kick", "gen1");
    const after = project.working.kick.gen1;
    const structChanged =
      (after.length !== before.length ? 1 : 0) +
      (after.hits !== before.hits ? 1 : 0) +
      (after.rotate !== before.rotate ? 1 : 0) +
      (after.probability !== before.probability ? 1 : 0);
    assert.equal(structChanged, 1);
    assert.ok(Math.abs(after.length - before.length) <= 2);
    assert.ok(Math.abs(after.hits - before.hits) <= 2);
    assert.ok(Math.abs(after.rotate - before.rotate) <= 2 || after.length !== before.length);
    assert.ok(Math.abs(after.probability - before.probability) <= 0.12);
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
