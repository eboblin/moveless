import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultDeck } from "../src/core/deck.ts";
import { defaultFx, defaultProject } from "../src/core/defaults.ts";
import { record, setRandomizeDepth, setRandomizeIntensity, setRandomizeScope } from "../src/core/performance.ts";
import {
  PROJECT_PATH,
  loadStoredProject,
  parseStored,
  saveStoredProject,
  serializeStored,
  type HostFiles,
} from "../src/core/persist.ts";

function memoryFiles(seed: Record<string, string> = {}): HostFiles & { store: Record<string, string> } {
  const store = { ...seed };
  return {
    store,
    ensure_dir: () => true,
    file_exists: (path) => path in store,
    read_file: (path) => (path in store ? store[path] : null),
    write_file: (path, content) => {
      store[path] = content;
      return true;
    },
  };
}

describe("project persist", () => {
  it("round-trips journal, sets, working and capture intensity", () => {
    let project = defaultProject();
    project = record(project);
    project = setRandomizeDepth(setRandomizeScope(setRandomizeIntensity(project, "hard"), "lane"), "generators");
    project.working.kick.gen1.hits = 7;
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: ["001"] }], activeSetId: "set-1" };
    const ui = { context: "bass" as const, page: 2, mode: "set" as const, playing: false };
    const raw = serializeStored(project, ui);
    const parsed = parseStored(raw);
    assert.ok(parsed);
    assert.equal(parsed.project.journal.length, 1);
    assert.equal(parsed.project.journal[0].id, "001");
    assert.equal(parsed.project.sets[0].sceneIds[0], "001");
    assert.equal(parsed.project.working.kick.gen1.hits, 7);
    assert.equal(parsed.project.randomizeIntensity, "hard");
    assert.equal(parsed.project.randomizeScope, "lane");
    assert.equal(parsed.project.randomizeDepth, "generators");
    assert.equal(parsed.ui.context, "bass");
    assert.equal(parsed.ui.page, 2);
    assert.equal(parsed.ui.mode, "set");
    assert.equal(parsed.ui.playing, false);
  });

  it("keeps a missing fx lane at the factory and ignores a stray fx field", () => {
    const project = defaultProject();
    const raw = JSON.parse(serializeStored(project, { context: "kick", page: 0, mode: "journal", playing: true })) as {
      project: { fx?: unknown; working: { fx?: unknown; bass: { send?: unknown } } };
    };
    delete raw.project.working.fx;
    delete raw.project.working.bass.send;
    raw.project.fx = { reverb: { size: 0.2 }, delay: { time: 0.15 } };
    const parsed = parseStored(JSON.stringify(raw));
    assert.ok(parsed);
    assert.equal(parsed.project.working.fx.reverb.size, defaultFx().reverb.size);
    assert.equal(parsed.project.working.fx.delay.time, defaultFx().delay.time);
    assert.equal(parsed.project.working.bass.send.reverb.value, 0);
    assert.equal(parsed.project.working.bass.send.delay.value, 0);
  });

  it("keeps the factory progression when an older file never stored one", () => {
    const project = record(defaultProject());
    const raw = JSON.parse(serializeStored(project, { context: "kick", page: 0, mode: "journal", playing: true })) as {
      project: {
        progression?: unknown;
        working: { chords: { start?: number; count?: number } };
        journal: { progression?: unknown; lanes: { chords: { start?: number } } }[];
      };
    };
    delete raw.project.progression;
    raw.project.working.chords.start = 3;
    raw.project.working.chords.count = 6;
    raw.project.journal[0].lanes.chords.start = 2;
    const parsed = parseStored(JSON.stringify(raw));
    assert.ok(parsed);
    assert.equal(parsed.project.progression.start, defaultProject().progression.start);
    assert.equal(parsed.project.progression.count, defaultProject().progression.count);
    assert.equal("progression" in parsed.project.journal[0], false);
  });

  it("keeps progression count 0 on the project and out of the scene", () => {
    const project = record(defaultProject());
    project.progression.count = 0;
    const parsed = parseStored(serializeStored(project, { context: "aux", page: 0, mode: "journal", playing: true }));
    assert.ok(parsed);
    assert.equal(parsed.project.progression.count, 0);
    assert.equal("progression" in parsed.project.journal[0], false);
  });

  it("keeps the bus on the project and fills a missing one with zeros", () => {
    const stored = JSON.parse(serializeStored(defaultProject(), { context: "aux", page: 0, mode: "journal", playing: true })) as {
      project: { bus?: unknown };
    };
    delete stored.project.bus;
    const missing = parseStored(JSON.stringify(stored));
    assert.ok(missing);
    assert.deepEqual(missing.project.bus, { glue: 0, pump: 0, wide: 0, tilt: 0 });
    const project = defaultProject();
    project.bus = { glue: 0.5, pump: 1, wide: 0.25, tilt: -0.4 };
    const parsed = parseStored(serializeStored(project, { context: "aux", page: 4, mode: "journal", playing: true }));
    assert.ok(parsed);
    assert.deepEqual(parsed.project.bus, project.bus);
    const recorded = record(project);
    assert.equal("bus" in recorded.journal[0], false);
    assert.deepEqual(recorded.bus, project.bus);
    const wild = JSON.parse(serializeStored(project, { context: "aux", page: 0, mode: "journal", playing: true })) as {
      project: { bus: { tilt: number; glue: number } };
    };
    wild.project.bus.tilt = 4;
    wild.project.bus.glue = -2;
    const clamped = parseStored(JSON.stringify(wild));
    assert.ok(clamped);
    assert.equal(clamped.project.bus.tilt, 1);
    assert.equal(clamped.project.bus.glue, 0);
  });

  it("keeps deck knobs on the project and fills a missing deck from the factory", () => {
    const stored = JSON.parse(serializeStored(defaultProject(), { context: "aux", page: 0, mode: "journal", playing: true })) as {
      project: { deck?: unknown };
    };
    delete stored.project.deck;
    const missing = parseStored(JSON.stringify(stored));
    assert.ok(missing);
    assert.deepEqual(missing.project.deck, defaultDeck());
    const project = defaultProject();
    project.deck = { ...defaultDeck(), div: 4, depth: 0.25 };
    const parsed = parseStored(serializeStored(project, { context: "aux", page: 0, mode: "journal", playing: true }));
    assert.ok(parsed);
    assert.deepEqual(parsed.project.deck, project.deck);
    const recorded = record(project);
    assert.equal("deck" in recorded.journal[0], false);
    assert.deepEqual(recorded.deck, project.deck);
  });

  it("lifts an old brake and scratch curve onto the new field", () => {
    const stored = JSON.parse(serializeStored(defaultProject(), { context: "aux", page: 0, mode: "journal", playing: true })) as {
      project: { deck: Record<string, unknown> };
    };
    stored.project.deck = { div: 2, len: 0.5, depth: 1, brake: 2, shape: 1, quant: 2, duty: 0.5, ramp: 0.5 };
    const parsed = parseStored(JSON.stringify(stored));
    assert.ok(parsed);
    assert.equal(parsed.project.deck.brake, 4);
    assert.equal(parsed.project.deck.div, 2);
    assert.equal(parsed.project.deck.vary, 0);
    assert.equal(parsed.project.deck.cells[3]?.y, 1);
    assert.equal(parsed.project.deck.cells[3]?.x, 1);
  });

  it("clears morph and wander origin on parse", () => {
    const project = defaultProject();
    project.morph = {
      start: project.working,
      targetId: "001",
      originTick: 100,
      durationTicks: 200,
      punched: [],
      lanes: null,
      t: 0,
    };
    project.wander = "fast";
    project.wanderOriginTick = 999;
    const parsed = parseStored(serializeStored(project, { context: "kick", page: 0, mode: "journal", playing: true }));
    assert.ok(parsed);
    assert.equal(parsed.project.morph, null);
    assert.equal(parsed.project.wander, "fast");
    assert.equal(parsed.project.wanderOriginTick, 0);
    const old = parseStored(JSON.stringify({ version: 1, project: { wander: "glacial" }, ui: { context: "kick", page: 0, mode: "journal" } }));
    assert.ok(old);
    assert.equal(old.project.wander, "slow");
  });

  it("fills missing fields from defaults and rejects bad JSON", () => {
    assert.equal(parseStored("{"), null);
    assert.equal(parseStored("{}"), null);
    const partial = JSON.stringify({
      version: 1,
      project: { randomizeIntensity: "soft", global: { tempo: 99 } },
      ui: { context: "snare", page: 99, mode: "journal" },
    });
    const parsed = parseStored(partial);
    assert.ok(parsed);
    assert.equal(parsed.project.randomizeIntensity, "soft");
    assert.equal(parsed.project.randomizeScope, "group");
    assert.equal(parsed.project.randomizeDepth, "all");
    assert.equal(parsed.project.global.tempo, 99);
    assert.equal(parsed.project.global.bar, defaultProject().global.bar);
    assert.ok(parsed.project.working.kick);
    assert.equal(parsed.ui.context, "snare");
    assert.equal(parsed.ui.page, 8);
    assert.equal(parsed.ui.playing, true);
  });

  it("reads randomize settings saved under the old capture keys", () => {
    const parsed = parseStored(JSON.stringify({
      version: 1,
      project: { captureNonce: 4, captureIntensity: "hard", captureScope: "lane", captureDepth: "values" },
    }));
    assert.ok(parsed);
    assert.equal(parsed.project.randomizeNonce, 4);
    assert.equal(parsed.project.randomizeIntensity, "hard");
    assert.equal(parsed.project.randomizeScope, "lane");
    assert.equal(parsed.project.randomizeDepth, "values");
  });

  it("replaces an old chord lane with defaults", () => {
    const project = defaultProject();
    const old = {
      change: { value: 0.35, pattern: 0, cycle: 1, amount: 0 },
      length: { value: 0.2, pattern: 0, cycle: 1, amount: 0 },
      play: { mode: 1, rate: 2, gate: 0.4, octaves: 3, spread: 0.9, flow: 0.1, strum: 0.4, direction: 1 },
    };
    const stored = {
      ...project,
      working: { ...project.working, chords: old },
      journal: [{ id: "001", color: 3, lanes: { ...project.working, chords: old } }],
    };
    const parsed = parseStored(JSON.stringify({
      version: 1,
      project: stored,
      ui: { context: "chords", page: 0, mode: "journal" },
    }));
    assert.ok(parsed);
    const fresh = defaultProject().working.chords;
    assert.deepEqual(parsed.project.working.chords, fresh);
    assert.deepEqual(parsed.project.journal[0].lanes.chords, fresh);
    assert.equal(parsed.project.journal[0].id, "001");
  });

  it("resets a chord lane that has no tone or octave", () => {
    const project = defaultProject();
    const legacy = {
      ...project.working.chords,
      spread: 0.9,
      flow: 0.1,
      octaves: 3,
      direction: 1,
    };
    delete (legacy as { tone?: unknown }).tone;
    delete (legacy as { octave?: unknown }).octave;
    const parsed = parseStored(JSON.stringify({
      version: 1,
      project: {
        ...project,
        working: { ...project.working, chords: legacy },
        journal: [{ id: "001", color: 3, lanes: { ...project.working, chords: legacy } }],
      },
      ui: { context: "chords", page: 0, mode: "journal" },
    }));
    assert.ok(parsed);
    const fresh = defaultProject().working.chords;
    assert.deepEqual(parsed.project.working.chords, fresh);
    assert.deepEqual(parsed.project.journal[0].lanes.chords, fresh);
  });

  it("resets a bass lane that still stores degree and range", () => {
    const project = defaultProject();
    const bass = {
      ...project.working.bass,
      degree: { value: 0.5, pattern: 4, cycle: 8, amount: 0.2 },
      range: { value: 1, pattern: 0, cycle: 3, amount: 0 },
    };
    delete (bass as { pitch?: unknown }).pitch;
    delete (bass as { octave?: unknown }).octave;
    const parsed = parseStored(JSON.stringify({
      version: 1,
      project: { ...project, working: { ...project.working, bass } },
      ui: { context: "bass", page: 3, mode: "journal" },
    }));
    assert.ok(parsed);
    assert.deepEqual(parsed.project.working.bass, defaultProject().working.bass);
    assert.equal("degree" in parsed.project.working.bass, false);
  });

  it("drops an unread strum instead of copying it into rate", () => {
    const project = defaultProject();
    const chords = {
      ...project.working.chords,
      strum: { value: 0.8, pattern: 2, cycle: 4, amount: 0 },
      rate: { value: 0, pattern: 0, cycle: 1, amount: 0 },
    };
    const parsed = parseStored(JSON.stringify({
      version: 1,
      project: { ...project, working: { ...project.working, chords } },
      ui: { context: "chords", page: 0, mode: "journal" },
    }));
    assert.ok(parsed);
    assert.equal(parsed.project.working.chords.rate.value, 0);
    assert.equal("strum" in parsed.project.working.chords, false);
  });

  it("drops clipboard when the scene is gone", () => {
    const project = record(defaultProject());
    project.clipboardSceneIds = ["missing"];
    const parsed = parseStored(serializeStored(project, { context: "kick", page: 0, mode: "journal", playing: true }));
    assert.ok(parsed);
    assert.deepEqual(parsed.project.clipboardSceneIds, []);
    const legacy = parseStored(JSON.stringify({
      version: 1,
      project: { ...project, clipboardSceneIds: undefined, clipboardSceneId: "001" },
      ui: { context: "kick", page: 0, mode: "journal", playing: true },
    }));
    assert.deepEqual(legacy?.project.clipboardSceneIds, ["001"]);
  });

  it("loads and saves through host file bindings", () => {
    const files = memoryFiles();
    const project = setRandomizeIntensity(defaultProject(), "clear");
    const ui = { context: "hat" as const, page: 1, mode: "journal" as const, playing: true };
    assert.equal(saveStoredProject(project, ui, files), true);
    assert.ok(PROJECT_PATH in files.store);
    const loaded = loadStoredProject(files);
    assert.ok(loaded);
    assert.equal(loaded.project.randomizeIntensity, "clear");
    assert.equal(loaded.ui.context, "hat");
    assert.equal(loaded.ui.page, 1);
    assert.equal(loadStoredProject({}), null);
  });
});
