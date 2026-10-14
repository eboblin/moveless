import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultProject } from "../src/core/defaults.ts";
import { record, setCaptureIntensity } from "../src/core/performance.ts";
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
    project = setCaptureIntensity(project, "hard");
    project.working.kick.gen1.hits = 7;
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: ["001"] }], activeSetId: "set-1" };
    const ui = { context: "bass" as const, page: 2, mode: "set" as const };
    const raw = serializeStored(project, ui);
    const parsed = parseStored(raw);
    assert.ok(parsed);
    assert.equal(parsed.project.journal.length, 1);
    assert.equal(parsed.project.journal[0].id, "001");
    assert.equal(parsed.project.sets[0].sceneIds[0], "001");
    assert.equal(parsed.project.working.kick.gen1.hits, 7);
    assert.equal(parsed.project.captureIntensity, "hard");
    assert.equal(parsed.ui.context, "bass");
    assert.equal(parsed.ui.page, 2);
    assert.equal(parsed.ui.mode, "set");
  });

  it("clears morph and wander origin on parse", () => {
    const project = defaultProject();
    project.morph = {
      start: project.working,
      targetId: "001",
      originTick: 100,
      durationTicks: 200,
      punched: [],
    };
    project.wander = "fast";
    project.wanderOriginTick = 999;
    const parsed = parseStored(serializeStored(project, { context: "kick", page: 0, mode: "journal" }));
    assert.ok(parsed);
    assert.equal(parsed.project.morph, null);
    assert.equal(parsed.project.wander, "fast");
    assert.equal(parsed.project.wanderOriginTick, 0);
  });

  it("fills missing fields from defaults and rejects bad JSON", () => {
    assert.equal(parseStored("{"), null);
    assert.equal(parseStored("{}"), null);
    const partial = JSON.stringify({
      version: 1,
      project: { captureIntensity: "soft", global: { tempo: 99 } },
      ui: { context: "snare", page: 99, mode: "journal" },
    });
    const parsed = parseStored(partial);
    assert.ok(parsed);
    assert.equal(parsed.project.captureIntensity, "soft");
    assert.equal(parsed.project.global.tempo, 99);
    assert.equal(parsed.project.global.bar, defaultProject().global.bar);
    assert.ok(parsed.project.working.kick);
    assert.equal(parsed.ui.context, "snare");
    assert.equal(parsed.ui.page, 6);
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

  it("folds a saved strum into rate", () => {
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
    assert.equal(parsed.project.working.chords.rate.value, 0.8);
    assert.equal("strum" in parsed.project.working.chords, false);
  });

  it("drops clipboard when the scene is gone", () => {
    const project = defaultProject();
    project.clipboardSceneId = "missing";
    const parsed = parseStored(serializeStored(project, { context: "kick", page: 0, mode: "journal" }));
    assert.ok(parsed);
    assert.equal(parsed.project.clipboardSceneId, null);
  });

  it("loads and saves through host file bindings", () => {
    const files = memoryFiles();
    const project = setCaptureIntensity(defaultProject(), "clear");
    const ui = { context: "hat" as const, page: 1, mode: "journal" as const };
    assert.equal(saveStoredProject(project, ui, files), true);
    assert.ok(PROJECT_PATH in files.store);
    const loaded = loadStoredProject(files);
    assert.ok(loaded);
    assert.equal(loaded.project.captureIntensity, "clear");
    assert.equal(loaded.ui.context, "hat");
    assert.equal(loaded.ui.page, 1);
    assert.equal(loadStoredProject({}), null);
  });
});
