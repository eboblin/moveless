import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { sampleOffset, unitForIndex } from "../src/core/clock.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { resolveForm } from "../src/core/events.ts";
import { applyMorph } from "../src/core/morph.ts";
import { motif, MOTIF_COUNT } from "../src/core/motif.ts";
import { modulated } from "../src/core/modulate.ts";
import {
  addSceneToSet,
  advance,
  captureLane,
  captureGenerator,
  createSet,
  launchScene,
  pickWanderCandidate,
  record,
  sceneColor,
  sceneIdsForPads,
  setMacro,
  audibleEvents,
} from "../src/core/performance.ts";
import { generatePhrase, previewPhrase } from "../src/core/phrase.ts";
import { chordLabels, textPreview } from "../src/core/text-preview.ts";
import { punch } from "../src/core/morph.ts";
import type { Project } from "../src/core/types.ts";

function bar(project: Project, length = 1): Project {
  const next = clone(project);
  for (const lane of ["kick", "snare", "hat", "perc", "bass", "lead"] as const) {
    next.working[lane].form.length = length;
    next.working[lane].form.repeats = 1;
    next.working[lane].form.abSplit = 1;
  }
  next.global.phrase = length;
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

describe("event generator", () => {
  it("places a four-on-the-floor kick on every fourth sixteenth", () => {
    const project = bar(defaultProject());
    const line = textPreview(project).split("\n")[0];
    assert.equal(line, "KCK x---x---x---x---");
  });

  it("unions a second generator without stacking two events on one step", () => {
    const project = bar(defaultProject());
    project.working.kick.events.a.g2 = { level: 1, cycle: 8, offset: 2 };
    project.working.kick.events.b.g2 = { level: 1, cycle: 8, offset: 2 };
    const steps = [...new Set(generatePhrase(project).lanes.kick.map((event) => event.step))];
    assert.deepEqual(steps, [0, 2, 4, 8, 10, 12]);
  });

  it("stays silent at level 0 and ignores the scene id", () => {
    const project = bar(defaultProject());
    project.working.kick.events.a.g1.level = 0;
    project.working.kick.events.b.g1.level = 0;
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

  it("changes probabilistic hits when the seed changes and keeps level 1 stable", () => {
    const project = bar(defaultProject());
    project.working.perc.events.a.g1 = { level: 0.45, cycle: 1, offset: 0 };
    project.working.perc.events.b.g1 = { level: 0.45, cycle: 1, offset: 0 };
    project.working.perc.events.a.g2.level = 0;
    project.working.perc.events.b.g2.level = 0;
    const a = generatePhrase(project).lanes.perc.length;
    project.global.seed = 2;
    const b = generatePhrase(project).lanes.perc.length;
    assert.notEqual(a, b);
    project.working.kick.events.a.g1.level = 1;
    const first = generatePhrase(project).lanes.kick.length;
    project.global.seed = 50;
    assert.equal(generatePhrase(project).lanes.kick.length, first);
  });

  it("keeps variation 0 identical to the base and lets later states move hits", () => {
    const base = bar(defaultProject());
    const varied = clone(base);
    varied.working.kick.form.varEvery = 1;
    varied.working.kick.form.varDiv = 4;
    varied.working.kick.form.varCount = 4;
    varied.working.kick.form.varAmount = 0;
    assert.deepEqual(generatePhrase(base).lanes.kick.map((e) => e.step), generatePhrase(varied).lanes.kick.map((e) => e.step));
    let moved = false;
    for (let seed = 1; seed <= 40 && !moved; seed++) {
      varied.global.seed = seed;
      varied.working.kick.form.varAmount = 1;
      const steps = generatePhrase(varied).lanes.kick.map((event) => event.step);
      moved = !steps.includes(4) || !steps.includes(12);
    }
    assert.equal(moved, true);
  });

  it("switches A to B at the split", () => {
    const project = bar(defaultProject());
    project.working.kick.form.abSplit = 0.5;
    project.working.kick.events.b.g1.level = 0;
    project.working.kick.events.b.g2.level = 0;
    const steps = generatePhrase(project).lanes.kick.map((event) => event.step);
    assert.deepEqual(steps, [0, 4]);
    assert.equal(resolveForm(project.working.kick.form, 4).partAt(8), "b");
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
    project.working.kick.events.a.g2 = { level: 1, cycle: 2, offset: 1 };
    project.working.kick.events.b.g2 = { level: 1, cycle: 2, offset: 1 };
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
  it("lerps levels and switches pattern ids at one half", () => {
    let project = defaultProject();
    project = punch(project, "kick.events.a.g1.level", 0);
    project = punch(project, "kick.ratchet.count.pattern", 2);
    project = record(project);
    project = punch(project, "kick.events.a.g1.level", 1);
    project = punch(project, "kick.ratchet.count.pattern", 10);
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "fast";
    project = launchScene(project, "002", 0);
    assert.equal(project.morph?.durationTicks, 4 * 192);
    const duration = 4 * 192;
    const mid = applyMorph(project, 376);
    assert.ok(Math.abs(mid.working.kick.events.a.g1.level - 376 / duration) < 1e-9);
    assert.equal(mid.working.kick.ratchet.count.pattern, 2);
    const half = applyMorph(project, duration / 2);
    assert.equal(half.working.kick.ratchet.count.pattern, 10);
    const done = applyMorph(project, 4 * 192);
    assert.equal(done.morph, null);
    assert.equal(done.working.kick.events.a.g1.level, 1);
  });

  it("advance lands a saved scene once the clock reaches it", () => {
    let project = defaultProject();
    project = punch(project, "kick.events.a.g1.level", 0.25);
    project = record(project);
    assert.equal(project.journal[0].color, sceneColor("001"));
    project = punch(project, "kick.events.a.g1.level", 0.9);
    project.transition = "now";
    project = launchScene(project, "001", 0);
    project = advance(project, 0);
    assert.equal(project.morph, null);
    assert.equal(project.working.kick.events.a.g1.level, 0.25);
    project = punch(project, "kick.events.a.g1.level", 0.2);
    project.transition = "fast";
    project = launchScene(project, "001", 10);
    const waiting = advance(project, 10);
    assert.ok(waiting.morph);
    assert.equal(waiting.working.kick.events.a.g1.level, 0.2);
    assert.ok((waiting.morph?.originTick ?? 0) > 10);
    const finished = advance(waiting, (waiting.morph?.originTick ?? 0) + (waiting.morph?.durationTicks ?? 0));
    assert.equal(finished.morph, null);
    assert.equal(finished.working.kick.events.a.g1.level, 0.25);
  });

  it("retargets from the interpolated state and leaves locked lanes alone", () => {
    let project = defaultProject();
    project = punch(project, "snare.events.a.g1.level", 0);
    project = record(project);
    project = punch(project, "snare.events.a.g1.level", 1);
    project = punch(project, "kick.events.a.g1.level", 0);
    project = record(project);
    project = punch(project, "kick.events.a.g1.level", 1);
    project = punch(project, "snare.events.a.g1.level", 1);
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.working.kick.events.a.g1.level = 0;
    project.transition = "slow";
    project = launchScene(project, "002", 0);
    project = applyMorph(project, 2 * 4 * 192);
    assert.ok(Math.abs(project.working.snare.events.a.g1.level - 0.25) < 1e-9);
    project.lock.kick = true;
    project = launchScene(project, "003", 2 * 192);
    assert.equal(project.morph?.start.snare.events.a.g1.level, project.working.snare.events.a.g1.level);
    const finished = applyMorph(project, project.morph!.originTick + project.morph!.durationTicks);
    assert.equal(finished.working.kick.events.a.g1.level, 0);
    assert.equal(finished.working.snare.events.a.g1.level, 1);
  });

  it("keeps a punched value through the end of a morph", () => {
    let project = defaultProject();
    project = punch(project, "hat.events.a.g1.level", 0);
    project = record(project);
    project = punch(project, "hat.events.a.g1.level", 1);
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project = launchScene(project, "002", 0);
    project = applyMorph(project, 100);
    project = punch(project, "hat.events.a.g1.level", 0.2);
    const done = applyMorph(project, project.morph!.originTick + project.morph!.durationTicks);
    assert.equal(done.working.hat.events.a.g1.level, 0.2);
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
    project.working.bass.form.follow = 1;
    project.working.chords.mood = modulated(0);
    project.working.chords.tension = modulated(0);
    const followed = generatePhrase(project).lanes.bass[0].note;
    project.working.bass.form.follow = 0;
    const free = generatePhrase(project).lanes.bass[0].note;
    assert.equal(followed, 24);
    assert.equal(free, 26);
    project.mute.chords = true;
    const phrase = generatePhrase(project);
    assert.ok(phrase.harmony.length > 0);
    assert.equal(chordLabels(project)[0], "0:maj");
    const heard = audibleEvents(project, phrase.lanes);
    assert.equal(heard.some((event) => event.lane === "chords"), false);
    assert.equal(heard.some((event) => event.lane === "bass"), true);
  });

  it("keeps bass notes stable when the arp direction changes", () => {
    const project = bar(defaultProject());
    project.working.chords.play.mode = 1;
    const up = generatePhrase(project);
    project.working.chords.play.direction = 1;
    const down = generatePhrase(project);
    assert.deepEqual(up.lanes.bass.map((event) => event.note), down.lanes.bass.map((event) => event.note));
    assert.notDeepEqual(up.lanes.chords.map((event) => event.note), down.lanes.chords.map((event) => event.note));
  });

  it("walks repeats along the scale", () => {
    const project = bar(defaultProject());
    project.working.bass.repeat = modulated(0.4);
    project.working.bass.step = modulated(1);
    project.working.bass.form.follow = 0;
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
    assert.notDeepEqual(captured.working.kick.events, project.working.kick.events);
    captured.lock.kick = true;
    const again = captureLane(captured, "kick");
    assert.equal(again.captureNonce, captured.captureNonce);
    assert.deepEqual(again.working.kick.events, captured.working.kick.events);
  });

  it("rerolls one generator and leaves the rest of the lane", () => {
    const project = defaultProject();
    const one = captureGenerator(project, "kick", "events.a.g1");
    assert.notDeepEqual(one.working.kick.events.a.g1, project.working.kick.events.a.g1);
    assert.deepEqual(one.working.kick.events.a.g2, project.working.kick.events.a.g2);
    assert.deepEqual(one.working.kick.events.b, project.working.kick.events.b);
    assert.deepEqual(one.working.kick.form, project.working.kick.form);
    assert.deepEqual(one.working.kick.ratchet, project.working.kick.ratchet);
    assert.deepEqual(one.working.kick.sound, project.working.kick.sound);
    const count = captureGenerator(project, "kick", "ratchet.count");
    assert.notDeepEqual(count.working.kick.ratchet.count, project.working.kick.ratchet.count);
    assert.deepEqual(count.working.kick.ratchet.rate, project.working.kick.ratchet.rate);
    const pitch = captureGenerator(project, "kick", "sound.pitch");
    assert.notDeepEqual(pitch.working.kick.sound.pitch, project.working.kick.sound.pitch);
    assert.deepEqual(pitch.working.kick.sound.tone, project.working.kick.sound.tone);
    pitch.lock.kick = true;
    const locked = captureGenerator(pitch, "kick", "events.a.g1");
    assert.equal(locked.captureNonce, pitch.captureNonce);
    assert.deepEqual(locked.working.kick.events.a.g1, pitch.working.kick.events.a.g1);
  });

  it("skips the previous wander target while another scene exists", () => {
    const ids = ["001", "002", "003"];
    for (let salt = 0; salt < 30; salt++) {
      assert.notEqual(pickWanderCandidate(ids, "002", 1, salt), "002");
    }
    assert.equal(pickWanderCandidate(["002"], "002", 1, 4), "002");
  });

  it("fills pads from the journal until a set has scenes, and stops at 32", () => {
    let project = defaultProject();
    project = record(project);
    project = record(punch(project, "kick.events.a.g1.level", 0.4));
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
    project = record(punch(project, "kick.events.a.g1.level", 0));
    project.wander = "fast";
    project.wanderOriginTick = 0;
    project.transition = "now";
    const later = advance(project, 2 * 4 * 192);
    assert.ok(later.wanderPreviousTarget === "001" || later.wanderPreviousTarget === "002");
  });
});
