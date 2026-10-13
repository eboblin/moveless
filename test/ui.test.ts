import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultProject } from "../src/core/defaults.ts";
import { createSet, record } from "../src/core/performance.ts";
import { lanePages, pageCount, pageGroupColor } from "../src/ui/pages.ts";
import { menuLed, padLeds, stepLed, stepLeds, trackLeds } from "../src/ui/leds.ts";
import { HEADER_H, PARAM_H, pixel, renderScreen, VIZ_H, type Screen } from "../src/ui/screen.ts";
import { defaultUi, openSetMode } from "../src/ui/state.ts";
import { reduce, relDelta, type Session } from "../src/ui/input.ts";

function session(): Session {
  return { project: defaultProject(), ui: defaultUi(), tick: 0, playing: false };
}

describe("pages and leds", () => {
  it("gives drums eight pages and bass ten", () => {
    assert.equal(pageCount("kick"), 8);
    assert.equal(pageCount("bass"), 10);
    assert.equal(pageCount("lead"), 10);
    assert.equal(pageCount("chords"), 8);
    assert.equal(lanePages("kick")[3].title.includes("COUNT"), true);
    assert.equal(lanePages("bass")[3].bindings[0]?.label, "DEGREE V");
    assert.equal(lanePages("kick")[2].bindings[7], null);
    assert.equal(lanePages("bass")[2].bindings[7]?.label, "FOLLOW");
  });

  it("follows the lane lamp rules", () => {
    const project = defaultProject();
    assert.deepEqual(stepLed(project, "snare", "kick"), { family: "red", color: 127, blink: false });
    assert.equal(stepLed(project, "kick", "kick").blink, true);
    assert.equal(stepLed(project, "lead", "bass").family, "yellow");
    assert.equal(stepLed(project, "bass", "bass").blink, true);
    assert.equal(stepLeds(project, "global")[8].family, "purple");
    assert.equal(stepLeds(project, "global")[8].blink, true);
    project.lock.lead = true;
    assert.equal(stepLed(project, "kick", "lead").family, "lock");
    assert.equal(stepLed(project, "kick", "lead").blink, false);
    assert.equal(stepLed(project, "lead", "lead").blink, true);
    assert.equal(stepLed(project, "lead", "lead").family, "lock");
    project.mute.snare = true;
    assert.equal(stepLed(project, "kick", "snare").family, "off");
    project.mute.bass = true;
    assert.equal(stepLed(project, "bass", "bass").family, "yellow");
    assert.equal(stepLed(project, "bass", "bass").blink, true);
    project.lock.bass = true;
    project.mute.bass = true;
    assert.equal(stepLed(project, "bass", "bass").family, "lock");
    assert.equal(stepLed(project, "kick", "bass").family, "lock");
    assert.equal(stepLed(project, "kick", "bass").blink, false);
  });

  it("lights saved scene pads and blinks the newest", () => {
    const empty = padLeds(defaultProject(), "journal");
    assert.equal(empty.length, 32);
    assert.ok(empty.every((item) => item.color === 0));
    let project = record(defaultProject());
    project = record(project);
    const journal = padLeds(project, "journal");
    assert.notEqual(journal[0].color, 0);
    assert.notEqual(journal[1].color, 0);
    assert.notEqual(journal[0].color, journal[1].color);
    assert.equal(journal[0].blink, false);
    assert.equal(journal[1].blink, true);
    assert.equal(journal[2].color, 0);
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: ["002"] }], activeSetId: "set-1" };
    const bank = padLeds(project, "set");
    assert.equal(bank[0].color, journal[1].color);
    assert.equal(bank[0].blink, true);
    assert.equal(bank[1].color, 0);
    const wheel = padLeds(project, "journal", { ...defaultUi(), wheelTouch: true });
    assert.equal(wheel[24].color, 3);
    assert.equal(wheel[24].blink, true);
    assert.equal(wheel[16].color, 0);
    assert.equal(wheel[0].color, 8);
    assert.equal(wheel[1].blink, true);
    assert.equal(wheel[4].color, 22);
    assert.equal(wheel[4].blink, false);
    assert.equal(wheel[27].color, 3);
    assert.equal(wheel[28].color, 20);
    const bass = padLeds(project, "journal", { ...defaultUi(), wheelTouch: true, context: "bass" });
    assert.equal(bass[24].color, 3);
    assert.equal(bass[27].color, 14);
    assert.equal(bass[30].color, 20);
    assert.equal(bass[16].color, 20);
    const chords = padLeds(project, "journal", { ...defaultUi(), wheelTouch: true, context: "chords" });
    assert.equal(chords[24].color, 14);
    assert.equal(chords[28].color, 20);
  });
});

describe("surface", () => {
  it("selects a lane on a short press and peeks without committing on a long one", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.heldLane, "bass");
    state = reduce({ ...state, tick: 10 }, { kind: "note", data1: 20, data2: 0 });
    assert.equal(state.ui.context, "bass");
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce({ ...state, tick: state.tick + 200 }, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.context, "bass");
  });

  it("turns pages from the wheel and commits a peeked page", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    assert.equal(state.ui.page, 1);
    state = reduce(state, { kind: "note", data1: 19, data2: 127 });
    state = reduce(state, { kind: "note", data1: 92, data2: 127 });
    assert.equal(state.ui.context, "perc");
    assert.equal(state.ui.page, 0);
    assert.equal(state.ui.heldLane, "perc");
    state = reduce(state, { kind: "note", data1: 93, data2: 127 });
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.heldLane, "perc");
    state = reduce(state, { kind: "note", data1: 19, data2: 0 });
    assert.equal(state.ui.heldLane, null);
    assert.equal(state.ui.context, "perc");
    assert.equal(state.ui.page, 1);
  });

  it("edits the focused parameter and draws the phrase under a fixed header", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 71, data2: 127 });
    assert.ok(state.project.working.kick.events.a.g1.level < 1);
    assert.equal(state.ui.focus?.label, "G1 LV");
    const screen = renderScreen(state.project, state.ui, 0);
    assert.equal(screen.header, "G1 LEVEL");
    assert.equal(screen.labels[0].text, "G1 LEVEL");
    const marked = screen.labels.find((label) => label.invert);
    assert.equal(marked?.text.trim().startsWith("LV "), true);
    assert.equal(HEADER_H + VIZ_H + PARAM_H, 64);
    assert.equal(pixel(screen, 0, HEADER_H - 1), 1);
    assert.equal(pixel(screen, 14, HEADER_H - 1), 1);
    assert.equal(pixel(screen, 15, HEADER_H - 1), 0);
    assert.equal(pixel(screen, 17, HEADER_H - 1), 0);
    assert.equal(pixel(screen, 0, HEADER_H), 0);
    assert.equal(pixel(screen, 0, HEADER_H + VIZ_H - 2), 0);
    assert.ok(columnSpan(screen, 0) > 0);
    assert.ok(columnSpan(screen, 0) <= VIZ_H / 2);
    assert.equal(pixel(screen, 4, HEADER_H + 8), 0);
  });

  it("draws one generator per line and leaves transport out of the header", () => {
    const screen = renderScreen(defaultProject(), defaultUi(), 0, true);
    assert.equal(screen.labels[0].text.includes("PLAY"), false);
    assert.equal(screen.labels[0].text.includes("STOP"), false);
    assert.match(screen.labels[0].text, /^KCK /);
    assert.equal(screen.labels[0].text.includes("JRN"), false);
    assert.equal(screen.labels[0].text.includes("SET"), false);
    const rows = screen.labels.filter((label) => label.y > HEADER_H);
    assert.deepEqual(rows.map((label) => label.text), ["G1 LV 100 CY 4 OF 0", "G2 LV 0 CY 7 OF 5"]);
    assert.deepEqual(rows.map((label) => label.x), [1, 1]);
    assert.ok(rows[0].y < rows[1].y);
    assert.equal(pixel(screen, 0, HEADER_H), 1);
    assert.equal(pixel(screen, 1, HEADER_H), 0);
    assert.equal(pixel(screen, 1, HEADER_H + VIZ_H - 2), 0);
    assert.ok(columnSpan(screen, 1) > 0);
    assert.ok(columnSpan(screen, 1) <= VIZ_H / 2);
    assert.equal(pixel(screen, 60, HEADER_H), 0);
    const turned = renderScreen(defaultProject(), { ...defaultUi(), page: 2 }, 0);
    assert.equal(pixel(turned, 1, HEADER_H - 1), 0);
    assert.equal(pixel(turned, 32, HEADER_H - 1), 1);
    assert.equal(pixel(turned, 33, HEADER_H - 1), 1);
    const mix = renderScreen(defaultProject(), { ...defaultUi(), context: "mix" }, 0);
    assert.equal(pixel(mix, 15, HEADER_H - 1), 1);
    const bass = renderScreen(defaultProject(), { ...defaultUi(), context: "bass" }, 0);
    assert.ok(columnSpan(bass, 0) <= VIZ_H / 2);
    assert.ok(pitchSpread(bass) > columnSpan(bass, 0));
    const chords = renderScreen(defaultProject(), { ...defaultUi(), context: "chords" }, 0);
    const chordRows = chords.labels.filter((label) => label.y > HEADER_H);
    assert.equal(chordRows.length, 2);
    assert.match(chordRows[0].text, /^CHANGE /);
    assert.match(chordRows[1].text, /^LENGTH /);
  });

  it("shows a modulated generator while its knob is held and the lane phrase after release", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    assert.equal(state.ui.page, 3);
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    assert.equal(state.ui.focus?.generator, "ratchet.count");
    const held = renderScreen(state.project, state.ui, 1000);
    assert.equal(held.viz, "generator");
    assert.equal(pixel(held, 4, HEADER_H + VIZ_H - 2), 1);
    state = reduce(state, { kind: "note", data1: 0, data2: 0 });
    const waiting = renderScreen(state.project, state.ui, state.ui.focus?.untilTick ? state.ui.focus.untilTick - 1 : 0);
    assert.equal(waiting.viz, "generator");
    const lane = renderScreen(state.project, state.ui, state.ui.focus?.untilTick ?? 0);
    assert.equal(lane.viz, "phrase");
    assert.equal(pixel(lane, 4, HEADER_H + VIZ_H - 2), 0);

    let pattern = session();
    pattern = reduce(pattern, { kind: "note", data1: 1, data2: 127 });
    const phrase = renderScreen(pattern.project, pattern.ui, 0);
    assert.equal(phrase.viz, "phrase");
    assert.equal(phrase.header, "G1 CYCLE");
  });

  it("draws a generator cycle on the phrase scale", () => {
    const screenFor = (cycle: number) => {
      const project = defaultProject();
      project.working.kick.ratchet.count = { value: 0.5, pattern: 0, cycle, amount: 1 };
      const ui = {
        ...defaultUi(),
        focus: { label: "COUNT C", generator: "ratchet.count", showPattern: false, held: true, untilTick: 0 },
      };
      return renderScreen(project, ui, 0);
    };
    const quarter = screenFor(4);
    const phrase = screenFor(16);
    assert.equal(pixel(quarter, 2, HEADER_H), 1);
    assert.equal(pixel(quarter, 10, HEADER_H), 1);
    assert.equal(pixel(phrase, 2, HEADER_H), 0);
    assert.equal(pixel(phrase, 8, HEADER_H), 1);
  });

  it("sets transition and toggles wander from the wheel-touch row", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.equal(state.project.transition, "now");
    const chosen = renderScreen(state.project, state.ui, 0, false, (state.ui.notice?.untilMs ?? 0) - 1);
    assert.equal(chosen.viz, "notice");
    assert.equal(chosen.labels.some((label) => label.text === "TRANSITION" && label.invert), true);
    assert.equal(chosen.labels.some((label) => label.text === "NOW" && label.invert), true);
    assert.equal(pixel(chosen, 4, HEADER_H + 8), 1);
    const gone = renderScreen(state.project, state.ui, 0, false, state.ui.notice?.untilMs ?? 0);
    assert.equal(gone.viz, "phrase");
    state = reduce(state, { kind: "note", data1: 72, data2: 127 });
    assert.equal(state.project.wander, "fast");
    state = reduce(state, { kind: "note", data1: 72, data2: 127 });
    assert.equal(state.project.wander, null);
    const screen = renderScreen(state.project, state.ui, 0, false, (state.ui.notice?.untilMs ?? 0) - 1);
    assert.equal(screen.viz, "notice");
    assert.equal(screen.labels.some((label) => label.text === "WANDER" && label.invert), true);
    assert.equal(screen.labels.some((label) => label.text === "OFF" && label.invert), true);
    assert.equal(screen.header.includes("T:"), false);
  });

  it("records, mutes, captures, and stores a track bookmark", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    assert.equal(state.project.journal.length, 1);
    state = reduce(state, { kind: "cc", data1: 88, data2: 127 });
    state = reduce(state, { kind: "note", data1: 19, data2: 127 });
    assert.equal(state.project.mute.perc, true);
    const events = state.project.working.kick.events.a.g1.cycle;
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    assert.equal(state.project.working.kick.events.a.g1.cycle, events);
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.notEqual(state.project.working.kick.events.a.g1.cycle, events);
    state = reduce(state, { kind: "cc", data1: 40, data2: 127 });
    state = reduce({ ...state, tick: 100 }, { kind: "cc", data1: 40, data2: 0 });
    assert.deepEqual(state.project.bookmarks[0], { context: "kick", page: 0 });
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[0].color, pageGroupColor("kick", 0));
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[0].blink, true);
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[1].color, 0);
    state = reduce(state, { kind: "cc", data1: 88, data2: 0 });
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    state = reduce({ ...state, tick: state.tick + 10 }, { kind: "note", data1: 20, data2: 0 });
    for (let n = 0; n < 6; n++) state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 41, data2: 127 });
    state = reduce({ ...state, tick: state.tick + 100 }, { kind: "cc", data1: 41, data2: 0 });
    assert.deepEqual(state.project.bookmarks[1], { context: "bass", page: 6 });
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[1].color, pageGroupColor("bass", 6));
    assert.notEqual(pageGroupColor("bass", 6), pageGroupColor("kick", 0));
    state = reduce(state, { kind: "cc", data1: 40, data2: 127 });
    state = reduce({ ...state, tick: state.tick + 10 }, { kind: "cc", data1: 40, data2: 0 });
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.page, 0);
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[0].blink, true);
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[1].blink, false);
  });

  it("rerolls only the generator whose encoder was held with capture", () => {
    let state = session();
    const before = state.project.working.kick;
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "note", data1: 1, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 72, data2: 1 });
    assert.equal(state.project.working.kick.events.a.g1.cycle, before.events.a.g1.cycle);
    assert.equal(state.ui.captureGenerator, "events.a.g1");
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.notDeepEqual(state.project.working.kick.events.a.g1, before.events.a.g1);
    assert.deepEqual(state.project.working.kick.events.a.g2, before.events.a.g2);
    assert.deepEqual(state.project.working.kick.form, before.form);
    assert.equal(state.ui.captureHeld, false);

    let count = session();
    const rate = count.project.working.kick.ratchet.rate;
    count = reduce(count, { kind: "cc", data1: 14, data2: 1 });
    count = reduce(count, { kind: "cc", data1: 14, data2: 1 });
    count = reduce(count, { kind: "cc", data1: 14, data2: 1 });
    count = reduce(count, { kind: "cc", data1: 52, data2: 127 });
    count = reduce(count, { kind: "note", data1: 0, data2: 127 });
    count = reduce(count, { kind: "cc", data1: 52, data2: 0 });
    assert.notDeepEqual(count.project.working.kick.ratchet.count, before.ratchet.count);
    assert.deepEqual(count.project.working.kick.ratchet.rate, rate);
    assert.deepEqual(count.project.working.kick.events, before.events);
  });

  it("captures the page group: pattern, notes, or sound", () => {
    let pattern = session();
    const kick = pattern.project.working.kick;
    pattern = reduce(pattern, { kind: "cc", data1: 52, data2: 127 });
    pattern = reduce(pattern, { kind: "cc", data1: 52, data2: 0 });
    assert.notDeepEqual(pattern.project.working.kick.events, kick.events);
    assert.deepEqual(pattern.project.working.kick.sound, kick.sound);

    let notes = session();
    notes = reduce(notes, { kind: "note", data1: 20, data2: 127 });
    notes = reduce({ ...notes, tick: notes.tick + 10 }, { kind: "note", data1: 20, data2: 0 });
    for (let n = 0; n < 3; n++) notes = reduce(notes, { kind: "cc", data1: 14, data2: 1 });
    const bass = notes.project.working.bass;
    notes = reduce(notes, { kind: "cc", data1: 52, data2: 127 });
    notes = reduce(notes, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(notes.ui.page, 3);
    assert.notDeepEqual(notes.project.working.bass.degree, bass.degree);
    assert.deepEqual(notes.project.working.bass.events, bass.events);
    assert.deepEqual(notes.project.working.bass.sound, bass.sound);

    let sound = session();
    for (let n = 0; n < 4; n++) sound = reduce(sound, { kind: "cc", data1: 14, data2: 1 });
    const heard = sound.project.working.kick;
    sound = reduce(sound, { kind: "cc", data1: 52, data2: 127 });
    sound = reduce(sound, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(sound.ui.page, 4);
    assert.notDeepEqual(sound.project.working.kick.sound, heard.sound);
    assert.deepEqual(sound.project.working.kick.events, heard.events);
  });

  it("pastes a journal reference into the active set", () => {
    let state = openSetMode({ ...session().ui });
    let project = record(defaultProject());
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: [] }], activeSetId: "set-1" };
    let current: Session = { project, ui: state, tick: 0, playing: false };
    current = reduce(current, { kind: "cc", data1: 60, data2: 127 });
    current = reduce(current, { kind: "note", data1: 68, data2: 127 });
    assert.deepEqual(current.project.sets[0].sceneIds, ["001"]);
    assert.equal(relDelta(65), -63);
  });

  it("locks with Loop and switches journal and set from the menu button", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 58, data2: 127 });
    state = reduce(state, { kind: "note", data1: 17, data2: 127 });
    assert.equal(state.project.lock.snare, true);
    assert.equal(state.ui.context, "kick");
    state = reduce(state, { kind: "note", data1: 17, data2: 127 });
    assert.equal(state.project.lock.snare, false);

    let project = record(defaultProject());
    project = record(project);
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: ["002"] }], activeSetId: "set-1" };
    state = { project, ui: defaultUi(), tick: 0, playing: false };
    assert.equal(menuLed(state.ui.mode).family, "yellow");
    assert.equal(renderScreen(state.project, state.ui, 0).header.includes("JRN"), false);
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.equal(state.project.morph?.targetId, "001");
    state = reduce(state, { kind: "cc", data1: 50, data2: 127 });
    assert.equal(state.ui.mode, "set");
    assert.equal(menuLed(state.ui.mode).family, "purple");
    assert.equal(renderScreen(state.project, state.ui, 0).header.includes("SET"), false);
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.equal(state.project.morph?.targetId, "002");
    state = reduce(state, { kind: "cc", data1: 50, data2: 127 });
    assert.equal(state.ui.mode, "journal");
  });

  it("deletes the current set with Delete and Down", () => {
    let project = createSet(defaultProject(), "A");
    project = createSet(project, "B");
    let state: Session = { project, ui: { ...defaultUi(), mode: "set" }, tick: 0, playing: false };
    state = reduce(state, { kind: "cc", data1: 119, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 54, data2: 127 });
    assert.equal(state.project.sets.length, 1);
    assert.equal(state.project.activeSetId, "set-1");
    state = reduce(state, { kind: "cc", data1: 119, data2: 0 });
    state = reduce(state, { kind: "cc", data1: 54, data2: 127 });
    assert.equal(state.project.sets.length, 1);
    assert.equal(state.project.activeSetId, "set-1");
  });
});

function columnSpan(screen: Screen, x: number): number {
  let count = 0;
  for (let y = HEADER_H; y < HEADER_H + VIZ_H - 1; y++) if (pixel(screen, x, y)) count++;
  return count;
}

function pitchSpread(screen: Screen): number {
  let min = HEADER_H + VIZ_H;
  let max = -1;
  for (let x = 0; x < 128; x++) {
    for (let y = HEADER_H; y < HEADER_H + VIZ_H - 1; y++) {
      if (!pixel(screen, x, y)) continue;
      if (y < min) min = y;
      if (y > max) max = y;
    }
  }
  return max < 0 ? 0 : max - min + 1;
}
