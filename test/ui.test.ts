import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { unitForIndex } from "../src/core/clock.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { modulated } from "../src/core/modulate.ts";
import { applyMorph } from "../src/core/morph.ts";
import { createSet, journalPadIds, journalPageCount, launchScene, record } from "../src/core/performance.ts";
import { generatePhrase } from "../src/core/phrase.ts";
import { bindingFor, lanePages, pageCount, pageGroup, pageGroupColor, pagesFor } from "../src/core/pages.ts";
import { LED, advancePulseClock, blinkHalfMs, directionLit, ledColorAt, menuLed, modeButtonLed, offColor, padLeds, padPackets, PLAY_LED_ON, playLed, PULSE_CLOCK_IDLE, shadeColor, stepLed, stepLeds, trackLeds } from "../src/ui/leds.ts";
import { DIGIT_H, displayAmount, plotAmount } from "../src/ui/digits.ts";
import { DIGIT_Y, FONT_H, HEADER_H, HEIGHT, NAME_Y, PAGER_Y, PARAM_COL_W, PARAM_H, SEP_Y, TITLE_Y, VALUE_Y, VIZ_H, pixel, renderScreen, type Screen } from "../src/ui/screen.ts";
import { defaultUi, HOLD_MS, HOLD_TICKS, openSetMode } from "../src/ui/state.ts";
import { reduce, relDelta, type Session } from "../src/ui/input.ts";
import { DETENT_CLICKS, DETENT_REST_MS, stepKnob } from "../src/ui/controls.ts";

function session(): Session {
  return { project: defaultProject(), ui: defaultUi(), tick: 0, playing: false };
}

function loop(state: Session): Session {
  return reduce(state, { kind: "cc", data1: 58, data2: 127 });
}

/** Mute held past the long-press threshold, so the peek is open at tick 0. */
function openMutePeek(state: Session): Session {
  const held = reduce(state, { kind: "cc", data1: 88, data2: 127 });
  return { ...held, ui: { ...held.ui, muteDownMs: Date.now() - HOLD_MS - 1 } };
}

/** Press the purple step, pick a page pad when needed, then release. */
function openAux(state: Session, page = 0): Session {
  let next = reduce(state, { kind: "note", data1: 23, data2: 127 });
  if (page > 0) next = reduce(next, { kind: "note", data1: 92 + page, data2: 127 });
  return reduce(next, { kind: "note", data1: 23, data2: 0 });
}

describe("pages and leds", () => {
  it("gives drums nine pages and bass eleven", () => {
    assert.equal(pageCount("kick"), 9);
    assert.equal(pageCount("bass"), 11);
    assert.equal(pageCount("lead"), 11);
    assert.equal(pageCount("chords"), 9);
    assert.equal(pageGroup("chords", 0), "pattern");
    assert.equal(pageGroup("kick", 7), "fx");
    assert.equal(pageGroup("kick", 8), "fx");
    assert.equal(pageGroup("bass", 9), "fx");
    assert.equal(pageGroup("bass", 10), "fx");
    assert.equal(pageGroup("chords", 2), "notes");
    assert.equal(pageGroupColor("chords", 2), 14);
    assert.equal(lanePages("chords")[2]?.groups[0], "VEL");
    assert.equal(pageGroup("chords", 7), "fx");
    assert.equal(pageGroup("chords", 8), "fx");
    assert.equal(pageGroupColor("kick", 7), 9);
    assert.equal(lanePages("bass").at(-1)?.groups[0], "REV");
    assert.equal(lanePages("bass").at(-1)?.groups[1], "DLY");
    assert.equal(lanePages("bass").at(-2)?.groups[0], "CUTOFF");
    assert.equal(lanePages("kick")[0].title, "GEN 1");
    assert.deepEqual(lanePages("kick")[0].groups, ["GEN 1", "VEL"]);
    assert.deepEqual(lanePages("kick")[2].groups, ["COUNT", "RATE"]);
    assert.equal(lanePages("kick")[1].title, "GEN 2");
    assert.equal(lanePages("kick")[0].bindings[3]?.label, "G1 PRB");
    assert.equal(lanePages("kick")[2].title.includes("COUNT"), true);
    assert.equal(lanePages("bass")[2].bindings[0]?.label, "REPEAT V");
    assert.equal(lanePages("bass")[2].groups[1], "STEP");
    assert.equal(lanePages("bass")[3].bindings[0]?.label, "PITCH V");
    assert.equal(lanePages("bass")[3].bindings[4]?.label, "OCTAVE V");
    assert.equal(lanePages("bass")[4].bindings[4]?.label, "FOLLOW");
    assert.equal(pageGroup("bass", 2), "pattern");
    assert.equal(pageGroupColor("bass", 2), pageGroupColor("bass", 0));
    assert.equal(pageGroup("bass", 3), "notes");
    assert.equal(pageGroup("lead", 2), "pattern");
    assert.equal(lanePages("kick")[0].bindings[4]?.label, "G1 VEL V");
    const aux = pagesFor("aux");
    assert.equal(pageCount("aux"), 6);
    assert.deepEqual(aux.map((page) => page.id), ["prog", "reverb", "delay", "settings", "play", "tone"]);
    assert.equal(aux[0].bindings[0]?.label, "START");
    assert.equal(pageGroup("aux", 0), "notes");
    assert.equal(pageGroupColor("aux", 0), 14);
    assert.equal(aux[1].bindings[0]?.label, "SIZE");
    assert.equal(aux[2].bindings[0]?.label, "TIME");
    assert.equal(pageGroup("aux", 1), "space");
    assert.equal(pageGroupColor("aux", 2), 9);
    assert.equal(pageGroup("aux", 3), "global");
    assert.equal(pageGroupColor("aux", 3), 8);
    assert.equal(aux[4].bindings[0]?.label, "DENS");
    assert.equal(aux[4].bindings[1]?.label, "REP");
    assert.equal(aux[5].bindings[0]?.label, "CUT");
    assert.equal(pageGroup("aux", 4), "macro");
    assert.equal(pageGroup("aux", 5), "macro");
    assert.equal(pageGroupColor("aux", 5), 22);
    assert.equal(aux.some((page) => page.title === "MACRO"), false);
  });

  it("follows the lane lamp rules", () => {
    const project = defaultProject();
    assert.deepEqual(stepLed(project, "snare", "kick"), { family: "red", color: 127, blink: false });
    assert.equal(stepLed(project, "kick", "kick").blink, true);
    assert.equal(stepLed(project, "lead", "bass").family, "yellow");
    assert.equal(stepLed(project, "bass", "bass").blink, true);
    assert.equal(stepLeds(project, "aux")[7].family, "purple");
    assert.equal(stepLeds(project, "aux")[7].blink, true);
    assert.equal(stepLeds(project, "kick")[7].blink, false);
    assert.equal(stepLeds(project, "aux")[8].family, "off");
    project.lock.lead = true;
    assert.equal(stepLed(project, "kick", "lead").family, "lock");
    assert.equal(stepLed(project, "kick", "lead").blink, false);
    assert.equal(stepLed(project, "lead", "lead").blink, true);
    assert.equal(stepLed(project, "lead", "lead").family, "lock");
    project.mute.snare = true;
    assert.equal(stepLed(project, "kick", "snare").family, "off");
    project.mute.bass = true;
    assert.equal(stepLed(project, "bass", "bass").family, "off");
    assert.equal(stepLed(project, "bass", "bass").blink, false);
    project.lock.bass = true;
    assert.equal(stepLed(project, "bass", "bass").family, "off");
    assert.equal(stepLed(project, "kick", "bass").family, "off");
    project.mute.bass = false;
    assert.equal(stepLed(project, "bass", "bass").family, "lock");
    assert.equal(stepLed(project, "bass", "bass").blink, true);
    project.solo.hat = true;
    assert.equal(stepLed(project, "kick", "kick").family, "off");
    assert.equal(stepLed(project, "kick", "hat").family, "red");
    assert.equal(stepLed(project, "bass", "bass").family, "off");
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
    assert.equal(journal[1].blinkTo, LED.white);
    assert.equal(ledColorAt(journal[1], 0, 120), journal[1].color);
    assert.equal(ledColorAt(journal[1], blinkHalfMs(120), 120), LED.white);
    assert.equal(empty[0].blinkTo, LED.white);
    assert.equal(journal[2].color, 0);
    const targetColor = journal[0].color;
    project = { ...project, transition: "fast" };
    project = launchScene(project, "001", 0);
    const start = padLeds(project, "journal", undefined, 0);
    assert.equal(start[0].blink, true);
    assert.equal(start[0].color, shadeColor(targetColor, 1 / 6));
    assert.equal(start[1].blink, true);
    assert.equal(start[1].blinkTo, LED.white);
    assert.equal(start[0].blinkTo, undefined);
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
    assert.equal(wheel[16].color, 9);
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
    assert.equal(bass[17].color, 9);
    const chords = padLeds(project, "journal", { ...defaultUi(), wheelTouch: true, context: "chords" });
    assert.equal(chords[24].color, 3);
    assert.equal(chords[26].color, 14);
    assert.equal(chords[28].color, 20);
    assert.equal(chords[16].color, 9);
  });

  it("pulses pads on the device and keeps the step blink on the wall clock", () => {
    assert.equal(playLed(true), PLAY_LED_ON);
    assert.equal(playLed(false), 0);
    assert.equal(modeButtonLed(true), PLAY_LED_ON);
    assert.equal(modeButtonLed(false), 0);
    const tempo = 120;
    const half = blinkHalfMs(tempo);
    assert.equal(half, 250);
    const step = stepLed({ ...defaultProject(), wander: "fast" as const }, "kick", "kick");
    assert.equal(step.blink, true);
    assert.equal(ledColorAt(step, 0, tempo), step.color);
    assert.equal(ledColorAt(step, half, tempo), step.blinkTo ?? LED.off);
    assert.equal(ledColorAt(step, half * 2, tempo), step.color);
    const project = { ...defaultProject(), wander: "fast" as const };
    const wheel = padLeds(project, "journal", { wheelTouch: true, context: "kick", page: 0 });
    const capture = padLeds(project, "journal", { captureHeld: true });
    const pads = [
      [68, padLeds(project, "journal")[0]],
      [92, wheel[24]],
      [69, wheel[1]],
      [72, wheel[4]],
      [71, capture[3]],
      [76, capture[8]],
      [81, capture[13]],
      [92, capture[24]],
    ] as const;
    for (const [note, lit] of pads) {
      assert.equal(lit.blink, true);
      assert.deepEqual(padPackets(note, lit), [
        [0x09, 0x90, note, lit.color],
        [0x09, 0x99, note, lit.blinkTo ?? LED.off],
      ]);
    }
    const steady = padLeds(project, "journal")[1];
    assert.equal(steady.blink, false);
    assert.deepEqual(padPackets(69, steady), [[0x09, 0x90, 69, steady.color]]);
  });

  it("arms the shared pulse on a quarter and does not restart it mid-cycle", () => {
    const quarter = 500;
    const step = quarter / 24;
    const mid = advancePulseClock(PULSE_CLOCK_IDLE, 100, 120);
    assert.deepEqual(mid.packets, []);
    assert.equal(mid.state.started, false);
    const armed = advancePulseClock(PULSE_CLOCK_IDLE, 1000, 120);
    assert.deepEqual(armed.packets, [[0x0f, 0xfa, 0x00, 0x00]]);
    assert.equal(armed.state.originMs, 1000);
    assert.equal(armed.state.sent, 0);
    const held = advancePulseClock(armed.state, 1000 + step / 2, 120);
    assert.deepEqual(held.packets, []);
    const ticked = advancePulseClock(armed.state, 1000 + step + 0.1, 120);
    assert.deepEqual(ticked.packets, [[0x0f, 0xf8, 0x00, 0x00]]);
    assert.equal(ticked.state.sent, 1);
    const again = advancePulseClock(ticked.state, 1000 + step + 0.1, 120);
    assert.deepEqual(again.packets, []);
    const retimed = advancePulseClock(ticked.state, 1000 + quarter / 2, 90);
    assert.equal(retimed.state.started, false);
    assert.deepEqual(retimed.packets, []);
  });
});

describe("surface", () => {
  it("opens the play page of the purple step", () => {
    let state = session();
    const before = clone(state.project.working.kick);
    state = openAux(state, 4);
    assert.equal(state.ui.context, "aux");
    assert.equal(state.ui.page, 4);
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.deepEqual(state.project.working.kick, before);
  });

  it("rerolls the mixer and a perf page from Capture", () => {
    let mix = openMutePeek(session());
    mix.project.mixer.kick = 0.5;
    mix = reduce(mix, { kind: "cc", data1: 71, data2: 1 });
    assert.ok(mix.project.mixer.kick > 0.5);
    mix.project.mixer.kick = 0.2;
    mix = loop(mix);
    assert.notEqual(mix.project.mixer.kick, 0.2);

    let perf = openAux(session(), 4);
    assert.equal(perf.ui.context, "aux");
    assert.equal(perf.ui.page, 4);
    perf.project.macros = { probability: 0.8, cutoff: 0.8 };
    perf = reduce(perf, { kind: "cc", data1: 52, data2: 127 });
    perf = reduce(perf, { kind: "note", data1: 0, data2: 127 });
    assert.notEqual(perf.project.macros.probability, 0.8);
    assert.equal(perf.project.macros.cutoff, 0.8);

    let cleared = openAux(session(), 4);
    cleared.project.macros = { probability: 0.8, cutoff: 0.8 };
    cleared = reduce(cleared, { kind: "cc", data1: 52, data2: 127 });
    cleared = reduce(cleared, { kind: "note", data1: 68 + 14, data2: 127 });
    cleared = reduce(cleared, { kind: "note", data1: 68, data2: 127 });
    cleared = loop(cleared);
    assert.equal(cleared.project.captureScope, "page");
    assert.equal(cleared.project.captureIntensity, "clear");
    assert.equal(cleared.project.macros.probability, 0);
    assert.equal(cleared.project.macros.cutoff, 0.8);
  });

  it("restores each lane's own page", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    assert.equal(state.ui.page, 2);
    state = reduce(state, { kind: "note", data1: 17, data2: 127 });
    const peek = renderScreen(state.project, state.ui, 0);
    assert.equal(peek.header.startsWith("SNR"), true);
    assert.equal(peek.header.includes("COUNT"), false);
    state = reduce(state, { kind: "note", data1: 17, data2: 0 });
    assert.equal(state.ui.context, "snare");
    assert.equal(state.ui.page, 0);
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    assert.equal(state.ui.page, 4);
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce(state, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.page, 2);
    state = reduce(state, { kind: "note", data1: 17, data2: 127 });
    state = reduce(state, { kind: "note", data1: 17, data2: 0 });
    assert.equal(state.ui.context, "snare");
    assert.equal(state.ui.page, 4);
  });

  it("selects a lane on release whether the press was short or long", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.heldContext, "bass");
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
    assert.equal(state.ui.heldContext, "perc");
    state = reduce(state, { kind: "note", data1: 93, data2: 127 });
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.heldContext, "perc");
    state = reduce(state, { kind: "note", data1: 19, data2: 0 });
    assert.equal(state.ui.heldContext, null);
    assert.equal(state.ui.context, "perc");
    assert.equal(state.ui.page, 1);
  });

  it("peeks the purple button as grouped pages", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 23, data2: 127 });
    assert.equal(state.ui.heldContext, "aux");
    assert.equal(state.ui.context, "kick");
    const held = padLeds(state.project, "journal", state.ui);
    assert.deepEqual(held.slice(24, 32).map((led) => led.color), [14, 9, 9, 8, 22, 22, 0, 0]);
    assert.equal(held[24].blink, true);
    state = reduce(state, { kind: "note", data1: 93, data2: 127 });
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.heldContext, "aux");
    state = reduce(state, { kind: "note", data1: 23, data2: 0 });
    assert.equal(state.ui.context, "aux");
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.heldContext, null);

    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    const wheel = padLeds(state.project, "journal", state.ui);
    assert.equal(wheel[24].color, 14);
    assert.equal(wheel[25].color, 9);
    assert.equal(wheel[25].blink, true);
    assert.equal(wheel[29].color, 22);
    assert.equal(wheel[31].color, 0);
  });

  it("zeros a knob on shift plus tap and leaves a plain tap alone", () => {
    let state = session();
    state.project.working.kick.gen1.length = 16;
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    assert.equal(state.project.working.kick.gen1.length, 16);

    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    assert.equal(state.project.working.kick.gen1.length, 0);

    state = session();
    state.project.global.tempo = 140;
    state.ui.context = "aux";
    state.ui.page = 3;
    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    assert.equal(state.project.global.tempo, 40);
  });

  it("edits the focused parameter and draws the phrase under a fixed header", () => {
    let state = session();
    state.project.working.kick.gen1 = { ...state.project.working.kick.gen1, length: 15, hits: 4, rotate: 0, probability: 1 };
    state.project.working.kick.gen2.hits = 0;
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
      min: 0,
      max: 64,
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
    project.solo.snare = true;
    project.solo.kick = true;
    project.lock.bass = true;
    project.mute.bass = true;
    project.mixer.kick = 1;
    project.mixer.master = 0;
    const screen = renderScreen(project, openMutePeek({ project, ui: defaultUi(), tick: 0, playing: false }).ui, 0);
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
    assert.ok(screen.labels.some((label) => label.text === "MS" && label.y === markY && label.x >= 16 && label.x < 32));
    assert.ok(screen.labels.some((label) => label.text === "ML" && label.y === markY && label.x >= 64 && label.x < 80));
    const snareMid = 16 + 8;
    for (const x of [snareMid - 1, snareMid, snareMid + 1]) {
      assert.equal(pixel(screen, x, faderBottom), (x + faderBottom) % 2 === 0 ? 1 : 0);
    }
    assert.equal(pixel(screen, kickMid + 1, faderBottom), 1);
    const hatMid = 32 + 8;
    for (const x of [hatMid - 1, hatMid, hatMid + 1]) {
      assert.equal(pixel(screen, x, faderBottom), (x + faderBottom) % 2 === 0 ? 1 : 0);
    }
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
    project.working.bass.length = modulated(0);
    project.working.bass.repeat = modulated(unitForIndex(1, 8));
    project.working.bass.step = modulated(1);
    project.working.bass.pitch = modulated(0.2);
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

  it("shows the current bass loop during a morph, not the whole phrase", () => {
    let project = defaultProject();
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.length = modulated(0.2);
    project.working.lead.gen1 = { ...project.working.lead.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.lead.gen2.hits = 0;
    project.working.lead.length = modulated(0.2);
    project = record(project);
    project.working.bass.pitch.value = 0.9;
    project.working.lead.pitch.value = 0.9;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "slow";
    project = launchScene(project, "002", 0);
    const ui = { ...defaultUi(), context: "bass" as const };
    const idle = renderScreen({ ...project, morph: null, working: project.morph!.start }, ui, 0, false);
    const first = renderScreen(project, ui, 0, false);
    assert.ok(litRuns(idle) > 1);
    assert.equal(litRuns(first), 1);
    assert.ok(columnSpan(first, 0) > 0);
    const later = renderScreen(applyMorph(project, 16 * 48), ui, 0, false);
    assert.equal(litRuns(later), 1);
    assert.ok(columnSpan(later, 0) > 0);
    const lead = renderScreen(project, { ...defaultUi(), context: "lead" }, 0, false);
    assert.equal(litRuns(lead), 1);
  });

  it("fits the morph picture to the lane length and resizes it when that length changes", () => {
    let project = defaultProject();
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.kick.gen2 = { ...project.working.kick.gen2, length: 0, hits: 0 };
    project = record(project);
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 12, hits: 1, rotate: 0, probability: 1 };
    project.working.kick.gen2 = { ...project.working.kick.gen2, length: 0, hits: 0 };
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "slow";
    project = launchScene(project, "002", 0);
    const ui = { ...defaultUi(), context: "kick" as const };
    const early = renderScreen(project, ui, 0, false);
    const intoNextPass = renderScreen(project, ui, 20 * 48, true);
    const still = renderScreen(project, ui, 20 * 48, false);
    assert.equal(litRuns(early), 1);
    assert.equal(runWidth(early), 7);
    assert.equal(playheadColumn(still, intoNextPass), Math.floor((4 * 128) / 16));
    const handed = renderScreen(applyMorph(project, (project.morph?.durationTicks ?? 0) * 0.95), ui, 0, false);
    assert.equal(litRuns(handed), 1);
    assert.equal(runWidth(handed), 9);
  });

  it("draws a phrase that is longer than the morph window at its own length", () => {
    let project = defaultProject();
    project.global.phrase = 1;
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 38, hits: 1, rotate: 0, probability: 1 };
    project.working.kick.gen2 = { ...project.working.kick.gen2, length: 0, hits: 0 };
    project = record(project);
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 38, hits: 1, rotate: 0, probability: 1 };
    project.working.kick.gen2 = { ...project.working.kick.gen2, length: 0, hits: 0 };
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "medium";
    project = launchScene(project, "002", 0);
    const ui = { ...defaultUi(), context: "kick" as const };
    const early = renderScreen(project, ui, 0, false);
    const handed = renderScreen(applyMorph(project, (project.morph?.durationTicks ?? 0) / 2), ui, 0, false);
    assert.equal(litRuns(early), 1);
    assert.equal(runWidth(early), 2);
    assert.equal(runWidth(handed), 2);
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
    const project = defaultProject();
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    const screen = renderScreen(project, defaultUi(), 0, true);
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
    const mix = renderScreen(defaultProject(), openMutePeek(session()).ui, 0);
    assert.ok([...Array(128).keys()].every((x) => pixel(mix, x, PAGER_Y) === 1));
    assert.equal(mix.viz, "mixer");
    assert.ok(mix.labels.some((label) => label.text === "KCK" && label.y === HEIGHT - FONT_H - 1));
    const bassProject = defaultProject();
    bassProject.working.bass.pitch = modulated(0.5, 0, 8, 1);
    bassProject.working.bass.follow = 0;
    bassProject.working.bass.length = modulated(0);
    bassProject.working.bass.gen1.hits = 8;
    const pitchPage = renderScreen(defaultProject(), { ...defaultUi(), context: "bass", page: 3 }, 0);
    assert.ok(pitchPage.digits.some((digit) => digit.cell === 0 && digit.amount.kind === "big" && digit.amount.n === 50));
    assert.ok(pitchPage.digits.some((digit) => digit.cell === 4 && digit.amount.kind === "big" && digit.amount.n === 2));
    const leadPitch = renderScreen(defaultProject(), { ...defaultUi(), context: "lead", page: 3 }, 0);
    assert.ok(leadPitch.digits.some((digit) => digit.cell === 4 && digit.amount.kind === "big" && digit.amount.n === 4));
    const pitchHeld = renderScreen(defaultProject(), {
      ...defaultUi(),
      context: "bass",
      page: 3,
      focus: { label: "PITCH V", path: "pitch.value", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(pitchHeld.header, "C2");
    const lengthPage = renderScreen(defaultProject(), { ...defaultUi(), context: "bass", page: 4 }, 0);
    assert.ok(lengthPage.labels.some((label) => label.text === "FOL"));
    const bass = renderScreen(bassProject, { ...defaultUi(), context: "bass" }, 0);
    assert.ok(columnSpan(bass, 0) <= VIZ_H / 2);
    assert.ok(pitchSpread(bass) > columnSpan(bass, 0));
    const chords = renderScreen(defaultProject(), { ...defaultUi(), context: "aux" }, 0);
    const chordNames = chords.labels.filter((label) => label.y === NAME_Y).map((label) => label.text);
    assert.deepEqual(chordNames, ["STA", "COU", "LEN", "MOT", "VAR", "MOO", "TEN", "WAY"]);
  });

  it("draws bass and lead notes across their length and wraps the tail", () => {
    const project = defaultProject();
    project.global.phrase = 1;
    project.global.bar = 4;
    for (const lane of ["bass", "lead"] as const) {
      project.working[lane].gen1 = { ...project.working[lane].gen1, length: 16, hits: 1, rotate: 15, probability: 1 };
      project.working[lane].gen2.hits = 0;
      project.working[lane].follow = 0;
      project.working[lane].length = modulated(1);
    }
    const bass = renderScreen(project, { ...defaultUi(), context: "bass" }, 0, false);
    assert.equal(columnSpan(bass, 119), 0);
    assert.ok(columnSpan(bass, 120) > 0);
    assert.ok(columnSpan(bass, 120) <= VIZ_H / 2);
    assert.ok(columnSpan(bass, 0) > 0);
    assert.ok(columnSpan(bass, 22) > 0);
    assert.equal(columnSpan(bass, 23), 0);
    const lead = renderScreen(project, { ...defaultUi(), context: "lead" }, 0, false);
    assert.ok(columnSpan(lead, 120) > 0);
    assert.ok(columnSpan(lead, 0) > 0);
    assert.equal(columnSpan(lead, 23), 0);

    project.working.bass.gen1.rotate = 0;
    project.working.bass.length = modulated(0.25);
    const short = renderScreen(project, { ...defaultUi(), context: "bass" }, 0, false);
    let run = 0;
    for (let x = 0; x < 128; x++) {
      if (columnSpan(short, x) > 0) run++;
      else if (run) break;
    }
    assert.equal(run, 7);
    assert.equal(columnSpan(short, 8), 0);
  });

  it("draws chord names with duration blocks, and a piano roll on the arp page", () => {
    const project = defaultProject();
    project.progression.count = 3;
    project.progression.length = 4;
    project.progression.variation = 0;
    const bars = renderScreen(project, { ...defaultUi(), context: "aux", page: 0 }, 0);
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
    const play = renderScreen(project, { ...defaultUi(), context: "chords", page: 0 }, 0);
    assert.ok(play.labels.some((label) => label.text === "RATE"));
    assert.ok(play.labels.some((label) => label.text === "GATE"));
    const tonePage = renderScreen(project, { ...defaultUi(), context: "chords", page: 1 }, 0);
    assert.match(tonePage.header, /TONE/);
    assert.match(tonePage.header, /OCTAVE/);
    const toneNames = tonePage.labels.filter((label) => label.y === NAME_Y).map((label) => label.text);
    assert.deepEqual(toneNames, ["V", "P", "C", "A", "V", "P", "C", "A"]);
    const toneHeld = renderScreen(project, {
      ...defaultUi(),
      context: "chords",
      page: 1,
      focus: { label: "TONE V", path: "tone.value", generator: "tone.value", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(toneHeld.header, "C4");
    const octaveHeld = renderScreen(project, {
      ...defaultUi(),
      context: "chords",
      page: 1,
      focus: { label: "OCTAVE V", path: "octave.value", generator: "octave.value", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(octaveHeld.header, "OCT 4");
    const zone = (rate: number) => renderScreen(
      { ...project, working: { ...project.working, chords: { ...project.working.chords, rate: modulated(rate) } } },
      { ...defaultUi(), context: "chords", page: 0, focus: { label: "RATE V", path: "rate.value", generator: "rate.value", showPattern: false, held: true, untilTick: 0, untilMs: 0 } },
      0,
    ).header;
    assert.equal(zone(0), "BLOCK");
    assert.equal(zone(0.01), "1/1");
    assert.equal(zone(0.25), "1/4");
    assert.match(zone(0.75), /^\d/);
    const roll = renderScreen(project, { ...defaultUi(), context: "chords", page: 1 }, 0);
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
    const global = renderScreen(defaultProject(), { ...defaultUi(), context: "aux", page: 3 }, 0);
    assert.equal(global.digits.some((d) => d.cell === 0), false);
    assert.ok(global.labels.some((label) => label.y === VALUE_Y && label.text === "120" && label.cell === 0));
    assert.ok(global.labels.some((label) => label.y === VALUE_Y && label.text === "C" && label.cell === 2));
    assert.ok(global.labels.some((label) => label.y === VALUE_Y && label.text === "MIN" && label.cell === 3));
    const keyed = defaultProject();
    keyed.global.root = 2;
    keyed.global.scale = "dorian";
    const mode = renderScreen(keyed, {
      ...defaultUi(),
      context: "aux",
      page: 3,
      focus: { label: "SCALE", path: "scale", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.ok(mode.labels.some((label) => label.y === VALUE_Y && label.text === "D" && label.cell === 2));
    assert.ok(mode.labels.some((label) => label.y === TITLE_Y && label.text === "DORIAN"));
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

  it("returns the lane view after a knob release while the clock is stopped, and when the page changes", () => {
    let state = session();
    state.tick = 40000;
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    state = reduce(state, { kind: "note", data1: 0, data2: 0 });
    const untilMs = state.ui.focus?.untilMs ?? 0;
    const frozen = state.tick;
    const waiting = renderScreen(state.project, state.ui, frozen, false, untilMs - 1);
    assert.equal(waiting.viz, "generator");
    assert.equal(waiting.header, "COUNT VALUE");
    const back = renderScreen(state.project, state.ui, frozen, false, untilMs);
    assert.equal(back.viz, "phrase");
    assert.equal(back.header, "KCK COUNT RATE");
    const restarted = renderScreen(state.project, state.ui, 0, true, untilMs);
    assert.equal(restarted.viz, "phrase");
    assert.equal(restarted.header, "KCK COUNT RATE");

    let turned = session();
    turned = reduce(turned, { kind: "cc", data1: 14, data2: 1 });
    turned = reduce(turned, { kind: "cc", data1: 14, data2: 1 });
    turned = reduce(turned, { kind: "note", data1: 0, data2: 127 });
    turned = reduce(turned, { kind: "note", data1: 0, data2: 0 });
    const preview = renderScreen(turned.project, turned.ui, 0, false, (turned.ui.focus?.untilMs ?? 0) - 1);
    assert.equal(preview.viz, "generator");
    turned = reduce(turned, { kind: "cc", data1: 14, data2: 1 });
    assert.equal(turned.ui.focus, null);
    assert.equal(turned.ui.page, 3);
    const next = renderScreen(turned.project, turned.ui, 0);
    assert.equal(next.viz, "phrase");
    assert.equal(next.header, "KCK PITCH BEND");
    assert.ok(next.labels.some((label) => label.text === "PITCH"));

    let held = session();
    held = reduce(held, { kind: "cc", data1: 14, data2: 1 });
    held = reduce(held, { kind: "cc", data1: 14, data2: 1 });
    held = reduce(held, { kind: "note", data1: 0, data2: 127 });
    assert.equal(renderScreen(held.project, held.ui, 0).viz, "generator");
    held = reduce(held, { kind: "cc", data1: 14, data2: 1 });
    const left = renderScreen(held.project, held.ui, 0);
    assert.equal(held.ui.focus, null);
    assert.equal(left.viz, "phrase");
    assert.equal(left.header, "KCK PITCH BEND");
  });

  it("draws a generator cycle on the phrase scale", () => {
    const screenFor = (cycle: number) => {
      const project = defaultProject();
      project.working.kick.ratchet.count = { value: 0.5, pattern: 0, cycle, amount: 1 };
      const ui = {
        ...defaultUi(),
        focus: { label: "COUNT C", path: "ratchet.count.cycle", generator: "ratchet.count", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
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
    assert.equal(state.project.mute.perc, false);
    assert.equal(state.ui.heldContext, "perc");
    state = reduce(state, { kind: "note", data1: 19, data2: 0 });
    assert.equal(state.ui.context, "perc");
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce(state, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.context, "kick");
    const beforeGen1 = clone(state.project.working.kick.gen1);
    state = reduce({ ...state, tick: state.tick + HOLD_TICKS }, { kind: "cc", data1: 88, data2: 0 });
    assert.equal(state.ui.muteLatched, false);
    state = loop(state);
    assert.notDeepEqual(state.project.working.kick.gen1, beforeGen1);
    state = reduce(state, { kind: "cc", data1: 40, data2: 127 });
    state = reduce({ ...state, tick: state.tick + 100 }, { kind: "cc", data1: 40, data2: 0 });
    assert.deepEqual(state.project.bookmarks[0], { context: "kick", page: 0 });
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[0].color, pageGroupColor("kick", 0));
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[0].blink, true);
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[1].color, 0);
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
    count = reduce(count, { kind: "note", data1: 68 + 4, data2: 127 });
    assert.equal(count.project.captureIntensity, "hard");
    count = reduce(count, { kind: "note", data1: 0, data2: 127 });
    assert.notDeepEqual(count.project.working.kick.ratchet.count, before.ratchet.count);
    assert.deepEqual(count.project.working.kick.ratchet.rate, rate);
    assert.deepEqual(count.project.working.kick.gen1, gen1);
  });

  it("rerolls the whole lane when scope is lane, and Shift does not widen it", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 12, data2: 127 });
    assert.equal(state.project.captureScope, "lane");
    assert.equal(state.ui.captureAction, true);
    const parked = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.deepEqual(state.project.working.kick, parked);

    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = loop(state);
    assert.equal(state.ui.shiftHeld, true);
    assert.notDeepEqual(state.project.working.kick.gen1, parked.gen1);
    assert.notDeepEqual(state.project.working.kick.sound, parked.sound);
  });

  it("captures the page group: pattern, notes, or sound", () => {
    let pattern = session();
    const kick = pattern.project.working.kick;
    pattern = loop(pattern);
    assert.notDeepEqual(pattern.project.working.kick.gen1, kick.gen1);
    assert.deepEqual(pattern.project.working.kick.sound, kick.sound);

    let notes = session();
    notes = reduce(notes, { kind: "note", data1: 20, data2: 127 });
    notes = reduce({ ...notes, tick: notes.tick + 10 }, { kind: "note", data1: 20, data2: 0 });
    for (let n = 0; n < 3; n++) notes = reduce(notes, { kind: "cc", data1: 14, data2: 1 });
    const bass = notes.project.working.bass;
    notes = loop(notes);
    assert.equal(notes.ui.page, 3);
    assert.notDeepEqual(notes.project.working.bass.pitch, bass.pitch);
    assert.deepEqual(notes.project.working.bass.gen1, bass.gen1);
    assert.deepEqual(notes.project.working.bass.sound, bass.sound);

    let sound = session();
    for (let n = 0; n < 4; n++) sound = reduce(sound, { kind: "cc", data1: 14, data2: 1 });
    const heard = sound.project.working.kick;
    sound = loop(sound);
    assert.equal(sound.ui.page, 4);
    assert.notDeepEqual(sound.project.working.kick.sound, heard.sound);
    assert.deepEqual(sound.project.working.kick.gen1, heard.gen1);
    assert.deepEqual(sound.project.working.kick.filter, heard.filter);

    let fx = session();
    for (let n = 0; n < 7; n++) fx = reduce(fx, { kind: "cc", data1: 14, data2: 1 });
    const open = fx.project.working.kick;
    fx = loop(fx);
    assert.equal(fx.ui.page, 7);
    assert.notDeepEqual(fx.project.working.kick.filter, open.filter);
    assert.deepEqual(fx.project.working.kick.sound, open.sound);
    assert.deepEqual(fx.project.working.kick.gen1, open.gen1);
  });

  it("keeps page-group capture when Shift is held", () => {
    let state = session();
    const before = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = loop(state);
    assert.equal(state.ui.shiftHeld, true);
    assert.notDeepEqual(state.project.working.kick.gen1, before.gen1);
    assert.deepEqual(state.project.working.kick.sound, before.sound);
  });

  it("shows the Capture menu and skips the release when a pad was pressed", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    assert.equal(state.ui.captureHeld, true);
    const pads = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(pads[24].color, 3);
    assert.equal(pads[24].blink, true);
    assert.equal(pads[24].blinkTo, 11);
    assert.equal(pads[27].blink, false);
    assert.equal(pads[17].color, 0);
    assert.equal(pads[0].color, 127);
    assert.equal(pads[0].blink, false);
    assert.equal(pads[1].color, 0);
    assert.equal(pads[2].color, shadeColor(LED.yellow, 0.2));
    assert.equal(pads[3].color, shadeColor(LED.yellow, 0.5));
    assert.equal(pads[3].blink, true);
    assert.equal(pads[4].color, shadeColor(LED.yellow, 1));
    assert.equal(pads[5].color, 0);
    assert.equal(pads[7].color, 0);
    assert.equal(pads[8].color, 11);
    assert.equal(pads[8].blink, true);
    assert.equal(pads[9].color, 5);
    assert.equal(pads[9].blink, false);
    assert.equal(pads[10].color, 25);
    assert.equal(pads[11].color, 0);
    assert.equal(pads[12].color, 3);
    assert.equal(pads[12].blink, false);
    assert.equal(pads[13].blink, true);
    assert.equal(pads[14].blink, false);

    const screen = renderScreen(state.project, state.ui, 0);
    assert.equal(screen.viz, "capture");
    const menu = screen.labels.filter((label) => label.y >= HEADER_H);
    const word = (text: string) => menu.find((label) => label.text === text);
    assert.equal(word("ALL")?.invert, true);
    assert.equal(word("GENERATORS")?.invert, false);
    assert.equal(word("VALUES")?.invert, false);
    assert.equal(word("GROUP")?.invert, true);
    assert.equal(word("LANE")?.invert, false);
    assert.equal(word("MED")?.invert, true);
    assert.equal(word("DELETE")?.invert, false);
    assert.ok(screen.digits.length > 0);

    const before = clone(state.project.working.kick);
    state = reduce(state, { kind: "note", data1: 68 + 24, data2: 127 });
    assert.equal(state.ui.page, 0);
    assert.equal(state.ui.captureAction, false);
    assert.deepEqual(state.project.working.kick, before);

    state = reduce(state, { kind: "note", data1: 68 + 9, data2: 127 });
    assert.equal(state.project.captureDepth, "generators");
    assert.equal(state.ui.captureAction, true);
    const parked = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(state.ui.captureLatched, true);
    assert.equal(state.ui.captureHeld, false);
    assert.deepEqual(state.project.working.kick, parked);

    state = reduce(state, { kind: "note", data1: 68 + 14, data2: 127 });
    assert.equal(state.project.captureScope, "page");
    state = loop(state);
    assert.equal(state.ui.page, 0);
    assert.equal(state.ui.captureLatched, true);
    assert.equal(state.project.working.kick.gen1.velocity.value, parked.gen1.velocity.value);
    assert.deepEqual(state.project.working.kick.sound, parked.sound);

    state = reduce(state, { kind: "note", data1: 68 + 13, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 8, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 0, data2: 127 });
    assert.equal(state.project.captureScope, "group");
    assert.equal(state.project.captureDepth, "all");
    assert.equal(state.project.captureIntensity, "clear");
    assert.equal(state.ui.notice, null);
    assert.equal(padLeds(state.project, state.ui.mode, state.ui)[24].blinkTo, 127);

    state.project.working.kick.sound.pitch = modulated(0.55, 9, 6, 0.4);
    const soundBefore = clone(state.project.working.kick.sound);
    for (let n = 0; n < 4; n++) state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = loop(state);
    assert.equal(state.project.working.kick.sound.pitch.value, 0);
    assert.equal(state.project.working.kick.sound.pitch.pattern, 0);
    assert.equal(state.project.working.kick.sound.pitch.amount, 0);
    assert.equal(state.project.working.kick.sound.pitch.cycle, 0);
    assert.notDeepEqual(state.project.working.kick.sound, soundBefore);
  });

  it("latches a short tap and rerolls only from Loop", () => {
    let state = session();
    const before = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(state.ui.captureLatched, true);
    assert.equal(state.ui.captureHeld, false);
    assert.deepEqual(state.project.working.kick, before);
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "capture");
    state = loop(state);
    assert.notDeepEqual(state.project.working.kick.gen1, before.gen1);
    assert.equal(state.ui.captureLatched, true);
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(state.ui.captureLatched, false);

    let held = session();
    const parked = clone(held.project.working.kick);
    held = reduce(held, { kind: "cc", data1: 52, data2: 127 });
    held = reduce({ ...held, tick: HOLD_TICKS }, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(held.ui.captureLatched, false);
    assert.equal(held.ui.captureHeld, false);
    assert.deepEqual(held.project.working.kick, parked);

    let mute = session();
    mute = reduce(mute, { kind: "cc", data1: 88, data2: 127 });
    mute = reduce(mute, { kind: "cc", data1: 88, data2: 0 });
    assert.equal(mute.ui.muteLatched, true);
    assert.equal(renderScreen(mute.project, mute.ui, 0).viz, "mixer");
    mute = reduce(mute, { kind: "cc", data1: 52, data2: 127 });
    assert.equal(renderScreen(mute.project, mute.ui, 0).viz, "capture");
    mute = reduce({ ...mute, tick: HOLD_TICKS }, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(mute.ui.captureLatched, false);
    assert.equal(mute.ui.muteLatched, true);
    assert.equal(renderScreen(mute.project, mute.ui, 0).viz, "mixer");
  });

  it("zeros on the next bare Capture after Delete was chosen", () => {
    let state = session();
    state.project.working.kick.gen1.velocity = modulated(0.7, 4, 5, 0.3);
    state.project.working.kick.sound.pitch = modulated(0.55, 9, 6, 0.4);
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 12, data2: 127 });
    const during = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.deepEqual(state.project.working.kick, during);
    state = loop(state);
    assert.equal(state.project.working.kick.gen1.length, 0);
    assert.equal(state.project.working.kick.gen1.velocity.value, 0);
    assert.equal(state.project.working.kick.sound.pitch.value, 0);
    assert.equal(state.project.working.kick.sound.pitch.cycle, 0);

    let mods = session();
    mods.project.working.kick.gen1.velocity = modulated(0.7, 4, 5, 0.3);
    mods.project.working.kick.sound.pitch = modulated(0.55, 9, 6, 0.4);
    const shape = mods.project.working.kick.gen1.length;
    mods = reduce(mods, { kind: "cc", data1: 52, data2: 127 });
    mods = reduce(mods, { kind: "note", data1: 68, data2: 127 });
    mods = reduce(mods, { kind: "note", data1: 68 + 9, data2: 127 });
    mods = reduce(mods, { kind: "note", data1: 68 + 12, data2: 127 });
    mods = reduce(mods, { kind: "cc", data1: 52, data2: 0 });
    mods = loop(mods);
    assert.equal(mods.project.working.kick.gen1.length, shape);
    assert.equal(mods.project.working.kick.gen1.velocity.value, 0.7);
    assert.equal(mods.project.working.kick.gen1.velocity.pattern, 0);
    assert.equal(mods.project.working.kick.gen1.velocity.cycle, 0);
    assert.equal(mods.project.working.kick.gen1.velocity.amount, 0);
    assert.equal(mods.project.working.kick.sound.pitch.value, 0.55);
    assert.equal(mods.project.working.kick.sound.pitch.pattern, 0);
    assert.equal(mods.project.working.kick.sound.pitch.cycle, 0);
    assert.equal(mods.project.working.kick.sound.pitch.amount, 0);
  });

  it("pastes a journal reference into the active set", () => {
    let project = record(defaultProject());
    project = record(project);
    let current: Session = { project, ui: defaultUi(), tick: 0, playing: false };
    current = reduce(current, { kind: "cc", data1: 60, data2: 127 });
    current = reduce(current, { kind: "note", data1: 68, data2: 127 });
    current = reduce(current, { kind: "note", data1: 69, data2: 127 });
    const marked = padLeds(current.project, "journal", current.ui)[0];
    assert.equal(marked.color, 126);
    assert.equal(marked.blink, true);
    assert.equal(marked.blinkTo, current.project.journal[0].color);
    current = reduce(current, { kind: "cc", data1: 60, data2: 0 });
    assert.deepEqual(current.project.clipboardSceneIds, ["001", "002"]);
    assert.equal(padLeds(current.project, "journal", current.ui)[0].color, current.project.journal[0].color);
    current = { ...current, ui: openSetMode(current.ui) };
    current = reduce(current, { kind: "cc", data1: 60, data2: 127 });
    current = reduce(current, { kind: "cc", data1: 60, data2: 0 });
    assert.deepEqual(current.project.sets[0].sceneIds, ["001", "002"]);
    assert.deepEqual(current.project.sets.at(-1)?.sceneIds, []);
    assert.deepEqual(current.project.clipboardSceneIds, []);
    assert.equal(padLeds(current.project, "set", current.ui)[0].color, current.project.journal[0].color);
    current = { ...current, ui: { ...current.ui, mode: "journal" } };
    current = reduce(current, { kind: "cc", data1: 60, data2: 127 });
    current = reduce(current, { kind: "note", data1: 68, data2: 127 });
    current = reduce({ ...current, tick: HOLD_TICKS }, { kind: "cc", data1: 60, data2: 0 });
    assert.deepEqual(current.project.clipboardSceneIds, ["001"]);
    current = reduce(current, { kind: "cc", data1: 60, data2: 127 });
    current = reduce({
      ...current,
      tick: current.tick + HOLD_TICKS,
      ui: { ...current.ui, copyDownMs: Date.now() - HOLD_MS - 1 },
    }, { kind: "cc", data1: 60, data2: 0 });
    assert.deepEqual(current.project.clipboardSceneIds, []);
    assert.equal(relDelta(65), -63);
  });

  it("records into the set and turns journal pages", () => {
    let state: Session = { ...session(), ui: { ...defaultUi(), mode: "set" } };
    state = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    assert.equal(state.project.journal.length, 1);
    assert.deepEqual(state.project.sets[0].sceneIds, ["001"]);
    assert.deepEqual(state.project.sets[1].sceneIds, []);
    assert.equal(state.project.activeSetId, "set-1");

    let project = defaultProject();
    for (let n = 0; n < 33; n++) project = record(project);
    state = { project, ui: defaultUi(), tick: 0, playing: false };
    assert.equal(directionLit(0, journalPageCount(project.journal.length)).down, PLAY_LED_ON);
    assert.equal(directionLit(0, journalPageCount(project.journal.length)).up, 0);
    state = reduce(state, { kind: "cc", data1: 54, data2: 127 });
    assert.equal(state.ui.journalPage, 1);
    assert.equal(journalPadIds(state.project, state.ui.journalPage)[0], "001");
    assert.equal(directionLit(1, journalPageCount(33)).up, PLAY_LED_ON);
  });

  it("restores a lane to factory defaults with Delete and its step", () => {
    let state = session();
    state.project.working.bass.pitch.value = 0.9;
    state.project.working.bass.gen1.hits = 7;
    state.project.working.bass.follow = 0.1;
    state.project.working.bass.filter.cutoff.value = 0.15;
    state.project.working.lead.pitch.value = 0.2;
    state.project.mute.bass = true;
    state.project.lock.bass = true;
    state.project.mixer.bass = 0.4;
    const factory = defaultProject().working.bass;
    state = reduce(state, { kind: "cc", data1: 119, data2: 127 });
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    assert.equal(state.project.working.bass.pitch.value, factory.pitch.value);
    assert.equal(state.project.working.bass.gen1.hits, factory.gen1.hits);
    assert.equal(state.project.working.bass.follow, factory.follow);
    assert.equal(state.project.working.bass.filter.cutoff.value, factory.filter.cutoff.value);
    assert.equal(state.project.working.lead.pitch.value, 0.2);
    assert.equal(state.project.mute.bass, true);
    assert.equal(state.project.lock.bass, true);
    assert.equal(state.project.mixer.bass, 0.4);
    state = reduce(state, { kind: "note", data1: 20, data2: 0 });
    assert.equal(state.ui.context, "bass");

    let morph = record(defaultProject());
    morph.working.kick.gen1.hits = 8;
    morph = launchScene(morph, morph.journal[0].id, 0);
    assert.ok(morph.morph);
    morph.working.kick.gen1.hits = 1;
    morph.working.snare.gen1.hits = 6;
    state = { project: morph, ui: { ...defaultUi(), deleteHeld: true }, tick: 0, playing: false };
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    assert.equal(state.project.working.snare.gen1.hits, 6);
    const kept = applyMorph(state.project, (state.project.morph?.originTick ?? 0) + 1);
    assert.equal(kept.working.kick.gen1.hits, defaultProject().working.kick.gen1.hits);
  });

  it("locks from the mute peek and switches journal and set from the menu button", () => {
    let state = openMutePeek(session());
    const leds = padLeds(state.project, "journal", state.ui);
    assert.equal(leds[24].color, 5);
    assert.equal(leds[24].blink, true);
    assert.equal(leds[24].blinkTo, offColor(5));
    assert.equal(leds[25].blink, false);
    assert.equal(leds[31].color, 0);
    assert.equal(leds[0].color, 0);
    state.project.mute.snare = true;
    assert.equal(padLeds(state.project, "journal", state.ui)[25].color, shadeColor(5, 0.5));
    state = reduce(state, { kind: "note", data1: 77, data2: 127 });
    assert.equal(state.project.lock.snare, true);
    assert.equal(padLeds(state.project, "journal", state.ui)[9].color, 22);
    assert.equal(state.ui.context, "kick");
    state = reduce(state, { kind: "note", data1: 85, data2: 127 });
    assert.equal(state.project.mute.snare, true);
    assert.equal(state.project.mute.kick, false);
    assert.equal(state.project.solo.snare, true);
    assert.equal(padLeds(state.project, "journal", state.ui)[25].color, shadeColor(5, 0.5));
    assert.equal(padLeds(state.project, "journal", state.ui)[17].color, 5);
    assert.equal(padLeds(state.project, "journal", state.ui)[16].color, shadeColor(5, 0.5));
    assert.equal(stepLed(state.project, "kick", "hat").family, "off");
    state = reduce(state, { kind: "note", data1: 86, data2: 127 });
    assert.equal(state.project.solo.hat, true);
    assert.equal(state.project.solo.snare, true);
    assert.equal(state.project.mute.kick, false);
    assert.equal(stepLed(state.project, "kick", "hat").family, "red");
    state = reduce(state, { kind: "note", data1: 85, data2: 127 });
    state = reduce(state, { kind: "note", data1: 86, data2: 127 });
    assert.equal(state.project.solo.snare, false);
    assert.equal(state.project.solo.hat, false);
    assert.equal(state.project.mute.snare, true);
    assert.equal(stepLed(state.project, "kick", "kick").family, "red");
    state = reduce(state, { kind: "note", data1: 77, data2: 127 });
    assert.equal(state.project.lock.snare, false);
    state = reduce(state, { kind: "cc", data1: 88, data2: 0 });
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "phrase");

    let project = record(defaultProject());
    project = record(project);
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: ["002"] }], activeSetId: "set-1" };
    state = { project, ui: defaultUi(), tick: 0, playing: false };
    assert.equal(menuLed(state.ui.mode), PLAY_LED_ON);
    assert.equal(renderScreen(state.project, state.ui, 0).header.includes("JRN"), false);
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.equal(state.project.morph?.targetId, "001");
    state = reduce(state, { kind: "cc", data1: 50, data2: 127 });
    assert.equal(state.ui.mode, "set");
    assert.equal(menuLed(state.ui.mode), 0);
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

function runWidth(screen: Screen): number {
  let width = 0;
  let on = false;
  for (let x = 0; x < 128; x++) {
    const lit = columnSpan(screen, x) > 0;
    if (lit) width++;
    else if (on) break;
    on = lit;
  }
  return width;
}

function playheadColumn(still: Screen, moving: Screen): number {
  for (let x = 0; x < 128; x++) {
    for (let y = HEADER_H; y < HEADER_H + VIZ_H - 1; y++) {
      if (pixel(still, x, y) !== pixel(moving, x, y)) return x;
    }
  }
  return -1;
}

function litRuns(screen: Screen): number {
  let runs = 0;
  let on = false;
  for (let x = 0; x < 128; x++) {
    const lit = columnSpan(screen, x) > 0;
    if (lit && !on) runs++;
    on = lit;
  }
  return runs;
}

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

describe("virtual detents", () => {
  function knob(path: string) {
    const found = bindingFor(path);
    assert.ok(found);
    return found;
  }

  it("catches a power of two and holds it for several clicks", () => {
    const cycle = knob("gen1.velocity.cycle");
    assert.deepEqual(cycle.detents, [1, 2, 4, 8, 16, 32, 64]);
    const caught = stepKnob(3, cycle, 1, null);
    assert.equal(caught.value, 4);
    assert.equal(caught.hold?.left, DETENT_CLICKS);
    let hold = caught.hold;
    for (let i = 0; i < DETENT_CLICKS; i++) {
      const stuck = stepKnob(4, cycle, 1, hold);
      assert.equal(stuck.value, 4);
      hold = stuck.hold;
    }
    const left = stepKnob(4, cycle, 1, hold);
    assert.equal(left.value, 5);
    assert.equal(left.hold, null);
    assert.equal(stepKnob(3, cycle, 7, null).value, 4);
    assert.equal(stepKnob(4, cycle, 7, null).value, 4);
    assert.equal(stepKnob(4, cycle, DETENT_CLICKS + 4, null).value, 8);
    const turned = stepKnob(4, cycle, -1, { path: cycle.path, dir: 1, left: 0, since: 0 });
    assert.equal(turned.value, 4);
    assert.equal(turned.hold?.dir, -1);
    assert.equal(turned.hold?.left, DETENT_CLICKS - 1);
  });

  it("holds zero in the middle, fifty on cutoff, and nothing on a plain knob", () => {
    const amount = knob("gen1.velocity.amount");
    assert.deepEqual(amount.detents, [0]);
    const onto = stepKnob(0.01, amount, -1, null);
    assert.equal(onto.value, 0);
    let hold = onto.hold;
    for (let i = 0; i < DETENT_CLICKS; i++) {
      const stuck = stepKnob(0, amount, -1, hold);
      assert.equal(stuck.value, 0);
      hold = stuck.hold;
    }
    const off = stepKnob(0, amount, -1, hold);
    assert.ok(Math.abs(off.value + 0.01) < 1e-9);

    const cutoff = knob("filter.cutoff.value");
    assert.deepEqual(cutoff.detents, [0.5]);
    const open = stepKnob(0.49, cutoff, 1, null);
    assert.equal(open.value, 0.5);
    const stay = stepKnob(open.value, cutoff, 1, open.hold);
    assert.equal(stay.value, 0.5);
    let cut = open.hold;
    for (let i = 0; i < DETENT_CLICKS; i++) cut = stepKnob(0.5, cutoff, 1, cut).hold;
    const past = stepKnob(0.5, cutoff, 1, cut);
    assert.ok(Math.abs(past.value - 0.51) < 1e-9);

    assert.deepEqual(knob("pitch.value").detents, [0.5]);
    assert.deepEqual(knob("macro.probability").detents, [0]);
    assert.deepEqual(knob("transpose").detents, [0]);
    assert.deepEqual(knob("start").detents, [0]);

    assert.deepEqual(knob("gen1.length").detents, [1, 2, 4, 8, 16, 32, 64]);
    assert.deepEqual(knob("gen2.length").detents, [1, 2, 4, 8, 16, 32, 64]);

    const hits = knob("gen1.hits");
    assert.equal(hits.detents, undefined);
    assert.equal(stepKnob(16, hits, 1, null).value, 17);
  });

  it("leaves a rested detent on the next click", () => {
    const cycle = knob("gen1.velocity.cycle");
    const caught = stepKnob(3, cycle, 1, null, 0);
    assert.equal(caught.value, 4);
    const soon = stepKnob(4, cycle, 1, caught.hold, DETENT_REST_MS);
    assert.equal(soon.value, 4);
    const rested = stepKnob(4, cycle, 1, caught.hold, DETENT_REST_MS + 1);
    assert.equal(rested.value, 5);
    assert.equal(rested.hold, null);
    const flick = stepKnob(4, cycle, 7, caught.hold, DETENT_REST_MS + 1);
    assert.equal(flick.value, 8);
  });
});

