import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { unitForIndex } from "../src/core/clock.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { modulated } from "../src/core/modulate.ts";
import { createSet, launchScene, record } from "../src/core/performance.ts";
import { generatePhrase } from "../src/core/phrase.ts";
import { lanePages, pageCount, pageGroupColor } from "../src/ui/pages.ts";
import { menuLed, padLeds, shadeColor, stepLed, stepLeds, trackLeds } from "../src/ui/leds.ts";
import { DIGIT_H, displayAmount, plotAmount } from "../src/ui/digits.ts";
import { DIGIT_Y, FONT_H, HEADER_H, HEIGHT, NAME_Y, PAGER_Y, PARAM_COL_W, PARAM_H, SEP_Y, TITLE_Y, VALUE_Y, VIZ_H, pixel, renderScreen, type Screen } from "../src/ui/screen.ts";
import { defaultUi, openSetMode } from "../src/ui/state.ts";
import { reduce, relDelta, type Session } from "../src/ui/input.ts";

function session(): Session {
  return { project: defaultProject(), ui: defaultUi(), tick: 0, playing: false };
}

describe("pages and leds", () => {
  it("gives drums seven pages and bass nine", () => {
    assert.equal(pageCount("kick"), 7);
    assert.equal(pageCount("bass"), 9);
    assert.equal(pageCount("lead"), 9);
    assert.equal(pageCount("chords"), 7);
    assert.equal(lanePages("kick")[0].title, "GEN 1");
    assert.deepEqual(lanePages("kick")[0].groups, ["GEN 1", "VEL"]);
    assert.deepEqual(lanePages("kick")[2].groups, ["COUNT", "RATE"]);
    assert.equal(lanePages("kick")[1].title, "GEN 2");
    assert.equal(lanePages("kick")[0].bindings[3]?.label, "G1 PRB");
    assert.equal(lanePages("kick")[2].title.includes("COUNT"), true);
    assert.equal(lanePages("bass")[2].bindings[0]?.label, "DEGREE V");
    assert.equal(lanePages("bass")[2].bindings[6]?.label, "FOLLOW");
    assert.equal(lanePages("kick")[0].bindings[4]?.label, "G1 VEL V");
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

  it("lights saved scene pads; active and morph target share beat blink, target shades", () => {
    const empty = padLeds(defaultProject(), "journal");
    assert.equal(empty.length, 32);
    assert.equal(empty[0].color, 8);
    assert.equal(empty[0].blink, true);
    assert.ok(empty.slice(1).every((item) => item.color === 0));
    const emptySet = padLeds(defaultProject(), "set");
    assert.equal(emptySet[0].blink, true);
    assert.equal(emptySet[0].color, 8);
    let project = record(defaultProject());
    project = record(project);
    assert.equal(project.activeSceneId, "002");
    const journal = padLeds(project, "journal");
    assert.notEqual(journal[0].color, 0);
    assert.notEqual(journal[1].color, 0);
    assert.notEqual(journal[0].color, journal[1].color);
    assert.equal(journal[0].blink, false);
    assert.equal(journal[1].blink, true);
    assert.equal(journal[2].color, 0);
    const targetColor = journal[0].color;
    project = { ...project, transition: "fast" };
    project = launchScene(project, "001", 0);
    const start = padLeds(project, "journal", undefined, 0);
    assert.equal(start[0].blink, true);
    assert.equal(start[0].color, shadeColor(targetColor, 1 / 6));
    assert.equal(start[1].blink, true);
    const halfTick = (project.morph?.originTick ?? 0) + (project.morph?.durationTicks ?? 0) / 2;
    const mid = padLeds(project, "journal", undefined, halfTick);
    assert.equal(mid[0].color, shadeColor(targetColor, 0.5));
    assert.equal(mid[0].blink, true);
    assert.equal(mid[1].blink, true);
    const endTick = (project.morph?.originTick ?? 0) + (project.morph?.durationTicks ?? 0);
    const end = padLeds(project, "journal", undefined, endTick);
    assert.equal(end[0].color, targetColor);
    assert.equal(end[0].blink, true);
    assert.equal(shadeColor(3, 0), 0);
    assert.equal(shadeColor(3, 0.2), 70);
    assert.equal(shadeColor(3, 0.5), 69);
    assert.equal(shadeColor(3, 1), 3);
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: ["002"] }], activeSetId: "set-1", morph: null };
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
    assert.equal(wheel[27].color, 20);
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
  it("selects a lane on release whether the press was short or long", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.heldLane, "bass");
    state = reduce({ ...state, tick: 10 }, { kind: "note", data1: 20, data2: 0 });
    assert.equal(state.ui.context, "bass");
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce({ ...state, tick: state.tick + 200 }, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.context, "kick");
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
    assert.ok(state.project.working.kick.gen1.length < 16);
    assert.equal(state.ui.focus?.label, "G1 LEN");
    const screen = renderScreen(state.project, state.ui, 0);
    assert.equal(screen.header, "GEN 1 LENGTH");
    assert.ok(screen.labels.some((label) => label.text === "GEN 1 LENGTH" && label.y === TITLE_Y));
    assert.ok(screen.labels.some((label) => label.text === "KCK" && label.y === TITLE_Y && !label.invert));
    const marked = screen.labels.filter((label) => label.invert);
    assert.ok(marked.some((label) => label.text === "LEN"));
    assert.equal(screen.digits[0]?.invert, true);
    assert.deepEqual(screen.digits[0]?.amount, displayAmount(state.project.working.kick.gen1.length, {
      path: "gen1.length",
      label: "G1 LEN",
      min: 0,
      max: 64,
      step: 1,
      integer: true,
    }));
    assert.equal(HEADER_H + VIZ_H + PARAM_H, 64);
    assert.equal(PAGER_Y, TITLE_Y + FONT_H + 1);
    assert.equal(HEADER_H, PAGER_Y + 2);
    assert.equal(pixel(screen, 0, PAGER_Y), 1);
    assert.equal(pixel(screen, 14, PAGER_Y), 1);
    assert.equal(pixel(screen, 16, PAGER_Y), 1);
    assert.equal(pixel(screen, 17, PAGER_Y), 0);
    assert.equal(pixel(screen, 0, HEADER_H), 0);
    assert.equal(pixel(screen, 0, HEADER_H + VIZ_H - 2), 0);
    assert.ok(columnSpan(screen, 0) > 0);
    assert.ok(columnSpan(screen, 0) <= VIZ_H / 2);
    assert.equal(pixel(screen, 20, HEADER_H + 8), 0);
  });

  it("draws eight mixer faders with mute and lock under each lane", () => {
    const project = defaultProject();
    project.mute.snare = true;
    project.lock.bass = true;
    project.mute.bass = true;
    project.mixer.kick = 1;
    project.mixer.master = 0;
    const screen = renderScreen(project, { ...defaultUi(), context: "mix" }, 0);
    assert.equal(screen.viz, "mixer");
    assert.equal(pixel(screen, 0, HEADER_H + VIZ_H - 1), 0);
    const kickMid = 8;
    const masterMid = 7 * 16 + 8;
    const faderTop = HEADER_H;
    const codeY = HEIGHT - FONT_H - 1;
    const markY = codeY - FONT_H - 1;
    const faderBottom = markY - 2;
    assert.equal(pixel(screen, kickMid, faderBottom), 1);
    // Master at 0: no fill beside the dotted guide (guide only on even rows).
    assert.equal(pixel(screen, masterMid + 1, faderTop), 0);
    assert.equal(pixel(screen, masterMid + 1, faderBottom), 0);
    const codes = screen.labels.filter((label) => label.y === codeY).map((label) => label.text);
    assert.deepEqual(codes, ["KCK", "SNR", "HAT", "PRC", "BAS", "LEA", "CHD", "MST"]);
    assert.ok(screen.labels.some((label) => label.text === "M" && label.y === markY && label.x >= 16 && label.x < 32));
    assert.ok(screen.labels.some((label) => label.text === "ML" && label.y === markY && label.x >= 64 && label.x < 80));
  });

  it("leaves a one-pixel gap between adjacent same-pitch hits", () => {
    const project = defaultProject();
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 16, rotate: 0 };
    project.working.kick.gen2.hits = 0;
    const screen = renderScreen(project, defaultUi(), 0, false);
    assert.ok(columnSpan(screen, 0) > 0);
    assert.ok(columnSpan(screen, 6) > 0);
    assert.equal(columnSpan(screen, 7), 0);
    assert.ok(columnSpan(screen, 8) > 0);
  });

  it("collapses monophonic overlaps so one sixteenth draws one event", () => {
    const project = defaultProject();
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 16, rotate: 0 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.follow = 0;
    project.working.bass.repeat = modulated(unitForIndex(1, 8));
    project.working.bass.step = modulated(1);
    project.working.bass.degree = modulated(0.2);
    project.working.bass.range = modulated(0.8);
    const ticks = new Map<number, number>();
    for (const event of generatePhrase(project).lanes.bass) {
      ticks.set(event.tick, (ticks.get(event.tick) ?? 0) + 1);
    }
    assert.ok([...ticks.values()].some((count) => count > 1));
    const notesAt = new Map<number, Set<number>>();
    for (const event of generatePhrase(project).lanes.bass) {
      const set = notesAt.get(event.tick) ?? new Set();
      set.add(event.note);
      notesAt.set(event.tick, set);
    }
    assert.ok([...notesAt.values()].some((notes) => notes.size > 1));
    const screen = renderScreen(project, { ...defaultUi(), context: "bass" }, 0, false);
    for (let x = 0; x < 128; x++) assert.ok(columnSpan(screen, x) <= VIZ_H / 2);
  });

  it("wraps ratchet tails into the phrase so the playhead still reaches the end", () => {
    const project = defaultProject();
    project.working.kick.ratchet.count = modulated(1);
    project.working.kick.ratchet.rate = modulated(unitForIndex(0, 6));
    const screen = renderScreen(project, defaultUi(), 0, false);
    const plain = renderScreen(defaultProject(), defaultUi(), 0, false);
    assert.ok(columnSpan(screen, 112) > 0);
    assert.equal(columnSpan(plain, 112), 0);
    assert.ok(columnSpan(screen, 0) > 0);
    const end = renderScreen(project, defaultUi(), 63 * 48, true);
    const still = renderScreen(project, defaultUi(), 63 * 48, false);
    let head = -1;
    for (let x = 0; x < 128; x++) {
      if (pixel(end, x, HEADER_H + 8) !== pixel(still, x, HEADER_H + 8)) head = x;
    }
    assert.ok(head >= 120);
  });

  it("draws eight parameter columns and leaves transport out of the header", () => {
    const screen = renderScreen(defaultProject(), defaultUi(), 0, true);
    const lane = screen.labels.find((label) => label.text === "KCK" && label.y === TITLE_Y);
    assert.ok(lane);
    assert.equal(lane?.invert, undefined);
    assert.ok((lane?.x ?? 0) > 100);
    assert.equal(screen.labels.some((label) => label.text === "GEN 1" && label.y === TITLE_Y), true);
    assert.equal(screen.labels.some((label) => label.text === "VEL" && label.y === TITLE_Y), true);
    assert.equal(screen.labels.some((label) => label.text.includes("PLAY") && label.y === TITLE_Y), false);
    assert.equal(screen.labels.some((label) => label.text.includes("JRN")), false);
    assert.equal(screen.labels.some((label) => label.text.includes("SET")), false);
    const genX = screen.labels.find((label) => label.text === "GEN 1")?.x ?? -1;
    const velX = screen.labels.find((label) => label.text === "VEL")?.x ?? -1;
    assert.equal(genX, 1);
    assert.equal(velX, 65);
    const names = screen.labels.filter((label) => label.y === NAME_Y);
    assert.deepEqual(names.map((label) => label.text), ["LEN", "HIT", "ROT", "PRB", "V", "P", "C", "A"]);
    assert.equal(NAME_Y, HEIGHT - FONT_H - 1);
    assert.equal(DIGIT_Y, NAME_Y - 2 - DIGIT_H);
    assert.equal(SEP_Y, DIGIT_Y - 4);
    assert.equal(pixel(screen, 0, SEP_Y), 1);
    assert.equal(pixel(screen, 63, SEP_Y), 1);
    assert.equal(pixel(screen, 127, SEP_Y), 1);
    // PRB=1 and VEL V=1 → natural 100 → small text; other six stay big digits.
    assert.equal(screen.digits.length, 6);
    assert.deepEqual(screen.digits[0]?.amount, { kind: "big", n: 16, negative: false });
    assert.ok(screen.labels.some((label) => label.y === VALUE_Y && label.text === "100" && label.cell === 3));
    assert.ok(screen.labels.some((label) => label.y === VALUE_Y && label.text === "100" && label.cell === 4));
    assert.equal(screen.labels.some((label) => label.y === DIGIT_Y), false);
    const ink: Array<[number, number]> = [];
    plotAmount(0, PARAM_COL_W, DIGIT_Y, { kind: "big", n: 16, negative: false }, (x, y) => ink.push([x, y]));
    assert.ok(ink.length > 20);
    assert.ok(ink.every(([x, y]) => x >= 0 && x < PARAM_COL_W && y >= DIGIT_Y && y < DIGIT_Y + DIGIT_H));
    names.forEach((label, index) => {
      assert.equal(label.cell, index);
      const left = index * 16;
      const mid = left + 8;
      assert.ok(label.x < mid && label.x + label.text.length * 5 > mid);
    });
    assert.equal(pixel(screen, 0, HEADER_H), 1);
    assert.equal(pixel(screen, 1, HEADER_H), 0);
    assert.equal(pixel(screen, 1, HEADER_H + VIZ_H - 2), 0);
    assert.ok(columnSpan(screen, 1) > 0);
    assert.ok(columnSpan(screen, 1) <= VIZ_H / 2);
    assert.equal(pixel(screen, 60, HEADER_H), 0);
    const turned = renderScreen(defaultProject(), { ...defaultUi(), page: 2 }, 0);
    assert.equal(pixel(turned, 1, PAGER_Y), 0);
    assert.equal(pixel(turned, 36, PAGER_Y), 1);
    assert.equal(pixel(turned, 37, PAGER_Y), 1);
    const mix = renderScreen(defaultProject(), { ...defaultUi(), context: "mix" }, 0);
    assert.equal(pixel(mix, 15, PAGER_Y), 1);
    assert.equal(mix.viz, "mixer");
    assert.ok(mix.labels.some((label) => label.text === "KCK" && label.y === HEIGHT - FONT_H - 1));
    const bassProject = defaultProject();
    bassProject.working.bass.degree = modulated(0.5, 0, 8, 1);
    bassProject.working.bass.follow = 0;
    bassProject.working.bass.gen1.hits = 8;
    const bass = renderScreen(bassProject, { ...defaultUi(), context: "bass" }, 0);
    assert.ok(columnSpan(bass, 0) <= VIZ_H / 2);
    assert.ok(pitchSpread(bass) > columnSpan(bass, 0));
    const chords = renderScreen(defaultProject(), { ...defaultUi(), context: "chords" }, 0);
    const chordNames = chords.labels.filter((label) => label.y === NAME_Y).map((label) => label.text);
    assert.deepEqual(chordNames, ["STA", "COU", "LEN", "MOT", "VAR", "MOO", "TEN", "WAY"]);
  });

  it("draws chord names with duration blocks, and a piano roll on the arp page", () => {
    const project = defaultProject();
    project.working.chords.count = 3;
    project.working.chords.length = 4;
    project.working.chords.variation = 0;
    const bars = renderScreen(project, { ...defaultUi(), context: "chords", page: 0 }, 0);
    const chordName = bars.labels.find((label) => label.text === "C" && label.y >= HEADER_H && label.y < HEADER_H + VIZ_H);
    assert.ok(chordName);
    const degree = bars.labels.find((label) => label.text === "I" && label.x === chordName.x);
    assert.ok(degree);
    assert.equal(degree.y, chordName.y + FONT_H + 1);
    assert.ok(columnSpan(bars, 0) > VIZ_H / 2);
    assert.equal(columnSpan(bars, 31), 0);
    const run = (x: number) => {
      let n = 0;
      while (x + n < 128 && columnSpan(bars, x + n) > 0) n++;
      return n;
    };
    assert.ok(run(0) < run(64));
    const play = renderScreen(project, { ...defaultUi(), context: "chords", page: 1 }, 0);
    assert.ok(play.labels.some((label) => label.text === "RATE"));
    assert.ok(play.labels.some((label) => label.text === "GATE"));
    const voiceNames = renderScreen(project, { ...defaultUi(), context: "chords", page: 2 }, 0)
      .labels.filter((label) => label.y === NAME_Y)
      .map((label) => label.text);
    assert.deepEqual(voiceNames.slice(0, 4), ["SPR", "FLO", "OCT", "DIR"]);
    const zone = (rate: number) => renderScreen(
      { ...project, working: { ...project.working, chords: { ...project.working.chords, rate: modulated(rate) } } },
      { ...defaultUi(), context: "chords", page: 1, focus: { label: "RATE V", generator: "rate.value", showPattern: false, held: true, untilTick: 0 } },
      0,
    ).header;
    assert.equal(zone(0), "BLOCK");
    assert.equal(zone(0.25), "1/16");
    assert.match(zone(0.75), /^\d/);
    const roll = renderScreen(project, { ...defaultUi(), context: "chords", page: 2 }, 0);
    assert.equal(
      roll.labels.some((label) => label.y >= HEADER_H && label.y < HEADER_H + VIZ_H && /^[A-G]/.test(label.text)),
      false,
    );
    assert.ok(pitchSpread(roll) > 1);
    assert.ok(columnSpan(roll, 0) > 1);
    assert.ok(columnSpan(roll, 0) < VIZ_H / 2);
    const sound = renderScreen(project, { ...defaultUi(), context: "chords", page: 3 }, 0);
    assert.equal(
      sound.labels.some((label) => label.y >= HEADER_H && label.y < HEADER_H + VIZ_H && /^[A-G]/.test(label.text)),
      false,
    );
    assert.ok(pitchSpread(sound) > 1);
  });

  it("keeps big digits for 0..99 and uses small 3+ digit text past that", () => {
    const small = { min: 0, max: 64, path: "x", label: "X", step: 1, integer: true };
    assert.deepEqual(displayAmount(0, small), { kind: "big", n: 0, negative: false });
    assert.deepEqual(displayAmount(32, small), { kind: "big", n: 32, negative: false });
    assert.deepEqual(displayAmount(64, small), { kind: "big", n: 64, negative: false });
    const unit = { min: 0, max: 1, path: "p", label: "P", step: 0.01, integer: false };
    assert.deepEqual(displayAmount(0.5, unit), { kind: "big", n: 50, negative: false });
    assert.deepEqual(displayAmount(1, unit), { kind: "wide", text: "100", negative: false });
    const tempo = { min: 40, max: 240, path: "tempo", label: "TEMPO", step: 1, integer: true };
    assert.deepEqual(displayAmount(80, tempo), { kind: "big", n: 80, negative: false });
    assert.deepEqual(displayAmount(120, tempo), { kind: "wide", text: "120", negative: false });
    assert.deepEqual(displayAmount(240, tempo), { kind: "wide", text: "240", negative: false });
    const seed = { min: 0, max: 999, path: "seed", label: "SEED", step: 1, integer: true };
    assert.deepEqual(displayAmount(42, seed), { kind: "big", n: 42, negative: false });
    assert.deepEqual(displayAmount(123, seed), { kind: "wide", text: "123", negative: false });
    assert.deepEqual(displayAmount(999, seed), { kind: "wide", text: "999", negative: false });
    const bipolar = { min: -1, max: 1, path: "y", label: "Y", step: 0.01, integer: false };
    assert.deepEqual(displayAmount(0, bipolar), { kind: "big", n: 0, negative: false });
    assert.deepEqual(displayAmount(-0.5, bipolar), { kind: "big", n: 50, negative: true });
    assert.deepEqual(displayAmount(1, bipolar), { kind: "wide", text: "100", negative: false });
    const dash: Array<[number, number]> = [];
    plotAmount(0, PARAM_COL_W, DIGIT_Y, { kind: "big", n: 7, negative: true }, (x, y) => dash.push([x, y]));
    assert.ok(dash.some(([, y]) => y === DIGIT_Y - 2));
    assert.ok(dash.some(([, y]) => y >= DIGIT_Y));
    const global = renderScreen(defaultProject(), { ...defaultUi(), context: "global" }, 0);
    assert.equal(global.digits.some((d) => d.cell === 0), false);
    assert.ok(global.labels.some((label) => label.y === VALUE_Y && label.text === "120" && label.cell === 0));
  });

  it("shows a modulated generator while its knob is held and the lane phrase after release", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    assert.equal(state.ui.page, 2);
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
    assert.equal(phrase.header, "GEN 1 HITS");
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
    assert.equal(pixel(quarter, 0, HEADER_H), 1);
    assert.equal(pixel(quarter, 0, HEADER_H + 1), 1);
    assert.equal(pixel(quarter, 32, HEADER_H), 1);
    assert.equal(pixel(quarter, 32, HEADER_H + 1), 1);
    assert.equal(pixel(phrase, 0, HEADER_H), 1);
    assert.equal(pixel(phrase, 0, HEADER_H + 1), 1);
    assert.equal(pixel(phrase, 32, HEADER_H + 1), 0);
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
    const beforeGen1 = clone(state.project.working.kick.gen1);
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    assert.deepEqual(state.project.working.kick.gen1, beforeGen1);
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.notDeepEqual(state.project.working.kick.gen1, beforeGen1);
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
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    assert.equal(state.ui.captureGenerator, "gen1");
    assert.notDeepEqual(state.project.working.kick.gen1, before.gen1);
    assert.deepEqual(state.project.working.kick.gen2, before.gen2);
    assert.equal(state.ui.notice, null);
    const afterTouch = state.project.working.kick.gen1;
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.deepEqual(state.project.working.kick.gen1, afterTouch);
    assert.equal(state.ui.captureHeld, false);

    let turn = session();
    const beforeTurn = turn.project.working.kick;
    turn = reduce(turn, { kind: "cc", data1: 52, data2: 127 });
    turn = reduce(turn, { kind: "cc", data1: 71, data2: 1 });
    assert.equal(turn.ui.captureGenerator, "gen1");
    assert.notDeepEqual(turn.project.working.kick.gen1, beforeTurn.gen1);
    assert.deepEqual(turn.project.working.kick.gen2, beforeTurn.gen2);

    let prob = session();
    const beforeProb = prob.project.working.kick;
    prob = reduce(prob, { kind: "cc", data1: 52, data2: 127 });
    prob = reduce(prob, { kind: "note", data1: 3, data2: 127 });
    assert.equal(prob.ui.captureGenerator, "gen1");
    assert.notDeepEqual(prob.project.working.kick.gen1, beforeProb.gen1);
    assert.deepEqual(prob.project.working.kick.gen2, beforeProb.gen2);

    let count = session();
    const rate = count.project.working.kick.ratchet.rate;
    const gen1 = clone(count.project.working.kick.gen1);
    count = reduce(count, { kind: "cc", data1: 14, data2: 1 });
    count = reduce(count, { kind: "cc", data1: 14, data2: 1 });
    count = reduce(count, { kind: "cc", data1: 52, data2: 127 });
    count = reduce(count, { kind: "note", data1: 68 + 3, data2: 127 });
    assert.equal(count.project.captureIntensity, "hard");
    count = reduce(count, { kind: "note", data1: 0, data2: 127 });
    assert.notDeepEqual(count.project.working.kick.ratchet.count, before.ratchet.count);
    assert.deepEqual(count.project.working.kick.ratchet.rate, rate);
    assert.deepEqual(count.project.working.kick.gen1, gen1);
  });

  it("rerolls the whole lane when Capture is released with Shift held", () => {
    let state = session();
    const before = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.notDeepEqual(state.project.working.kick.gen1, before.gen1);
    assert.notDeepEqual(state.project.working.kick.sound, before.sound);
    assert.equal(state.ui.shiftHeld, true);
  });

  it("captures the page group: pattern, notes, or sound", () => {
    let pattern = session();
    const kick = pattern.project.working.kick;
    pattern = reduce(pattern, { kind: "cc", data1: 52, data2: 127 });
    pattern = reduce(pattern, { kind: "cc", data1: 52, data2: 0 });
    assert.notDeepEqual(pattern.project.working.kick.gen1, kick.gen1);
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
    assert.deepEqual(notes.project.working.bass.gen1, bass.gen1);
    assert.deepEqual(notes.project.working.bass.sound, bass.sound);

    let sound = session();
    for (let n = 0; n < 4; n++) sound = reduce(sound, { kind: "cc", data1: 14, data2: 1 });
    const heard = sound.project.working.kick;
    sound = reduce(sound, { kind: "cc", data1: 52, data2: 127 });
    sound = reduce(sound, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(sound.ui.page, 4);
    assert.notDeepEqual(sound.project.working.kick.sound, heard.sound);
    assert.deepEqual(sound.project.working.kick.gen1, heard.gen1);
  });

  it("keeps page-group capture when Shift is not held", () => {
    let state = session();
    const before = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.notDeepEqual(state.project.working.kick.gen1, before.gen1);
    assert.deepEqual(state.project.working.kick.sound, before.sound);
  });

  it("shows Capture overlay pads and switches page when regenerating", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    assert.equal(state.ui.captureHeld, true);
    const pads = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(pads[24].color, 3);
    assert.equal(pads[24].blink, true);
    assert.equal(pads[0].color, 127);
    assert.equal(pads[0].blink, false);
    assert.equal(pads[2].blink, true);
    assert.equal(pads[1].color, 8);
    assert.equal(pads[3].color, 22);
    assert.equal(pads[4].color, 0);
    assert.equal(pads[8].color, 0);

    const beforeGen2 = clone(state.project.working.kick.gen2);
    const beforeSound = clone(state.project.working.kick.sound);
    const beforeGen1 = clone(state.project.working.kick.gen1);
    state = reduce(state, { kind: "note", data1: 68 + 25, data2: 127 });
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.captureAction, true);
    assert.notDeepEqual(state.project.working.kick.gen2, beforeGen2);
    assert.deepEqual(state.project.working.kick.gen1, beforeGen1);
    assert.deepEqual(state.project.working.kick.sound, beforeSound);
    const afterGen2 = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.deepEqual(state.project.working.kick, afterGen2);
    assert.equal(state.ui.captureHeld, false);
    assert.equal(state.ui.page, 1);

    const gen1BeforeSwitch = clone(state.project.working.kick.gen1);
    const gen2After = clone(state.project.working.kick.gen2);
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 24, data2: 127 });
    assert.equal(state.ui.page, 0);
    assert.equal(state.ui.captureAction, true);
    assert.notDeepEqual(state.project.working.kick.gen1, gen1BeforeSwitch);
    assert.deepEqual(state.project.working.kick.gen2, gen2After);
    assert.deepEqual(state.project.working.kick.sound, beforeSound);
    const afterGen1 = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.deepEqual(state.project.working.kick, afterGen1);
    assert.equal(state.ui.captureHeld, false);
    assert.equal(state.ui.page, 0);

    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 0, data2: 127 });
    assert.equal(state.project.captureIntensity, "clear");
    assert.equal(state.ui.notice?.title, "CAPTURE");
    assert.equal(state.ui.notice?.value, "CLEAR");
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });

    state.project.working.kick.sound.pitch = modulated(0.55, 9, 6, 0.4);
    const soundBefore = clone(state.project.working.kick.sound);
    for (let n = 0; n < 4; n++) state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(state.project.working.kick.sound.pitch.value, 0.55);
    assert.equal(state.project.working.kick.sound.pitch.pattern, 0);
    assert.equal(state.project.working.kick.sound.pitch.amount, 0);
    assert.equal(state.project.working.kick.sound.pitch.cycle, 6);
    assert.notDeepEqual(state.project.working.kick.sound, soundBefore);
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
    const setNotice = renderScreen(state.project, state.ui, 0, false, (state.ui.notice?.untilMs ?? 0) - 1);
    assert.equal(setNotice.viz, "notice");
    assert.equal(setNotice.labels.some((label) => label.text === "MODE" && label.invert), true);
    assert.equal(setNotice.labels.some((label) => label.text === "SET" && label.invert), true);
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.equal(state.project.morph?.targetId, "002");
    state = reduce(state, { kind: "cc", data1: 50, data2: 127 });
    assert.equal(state.ui.mode, "journal");
    const journalNotice = renderScreen(state.project, state.ui, 0, false, (state.ui.notice?.untilMs ?? 0) - 1);
    assert.equal(journalNotice.viz, "notice");
    assert.equal(journalNotice.labels.some((label) => label.text === "JOURNAL" && label.invert), true);
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

  it("Delete plus pad removes a set link or a journal scene", () => {
    let project = record(defaultProject());
    project = record(project);
    project = createSet(project, "A");
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: ["001", "002"] }], activeSetId: "set-1" };
    let state: Session = { project, ui: { ...defaultUi(), mode: "set" }, tick: 0, playing: false };
    state = reduce(state, { kind: "cc", data1: 119, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.deepEqual(state.project.sets[0].sceneIds, ["002"]);
    assert.equal(state.project.journal.length, 2);

    state = { ...state, ui: { ...state.ui, mode: "journal", deleteHeld: true } };
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.equal(state.project.journal.length, 1);
    assert.equal(state.project.journal[0].id, "002");
    assert.deepEqual(state.project.sets[0].sceneIds, ["002"]);
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
