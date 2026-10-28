import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { CHORD_RATES, RATES, SIXTEENTH_TICKS, unitForIndex } from "../src/core/clock.ts";
import { BRAKE_LABEL, DIV_LABEL } from "../src/core/deck.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { modulated } from "../src/core/modulate.ts";
import { applyMorph } from "../src/core/morph.ts";
import { parseStored, serializeStored } from "../src/core/persist.ts";
import { createSet, journalPadIds, journalPageCount, launchScene, record } from "../src/core/performance.ts";
import { generatePhrase } from "../src/core/phrase.ts";
import { bindingFor, lanePages, mixerPage, pageCount, pageGroup, pageGroupColor, pagesFor, scopeIncludesPage } from "../src/core/pages.ts";
import { LED, advancePulseClock, blinkHalfMs, directionLit, dropLed, faceButtonLed, ledColorAt, menuLed, modeButtonLed, offColor, offerLed, padLeds, padPackets, PLAY_LED_ON, playLed, PULSE_CLOCK_IDLE, sceneShadeStep, shadeColor, stepLed, stepLeds, takeLeds, trackLeds } from "../src/ui/leds.ts";
import { DIGIT_H, displayAmount, fractionFromLabel, plotAmount } from "../src/ui/digits.ts";
import { lettersWidth, plotLetters } from "../src/ui/letters.ts";
import { CAPTION_GAP, CAPTION_LANE_Y, CAPTION_OUTLINE, CAPTION_PAGE_Y, CAPTION_SINGLE_Y, CHAR_W, DIGIT_Y, FONT_H, HEADER_H, HEIGHT, NAME_Y, PAGER_Y, PARAM_COL_W, PARAM_H, SEP_Y, TITLE_Y, VALUE_Y, VIZ_H, WIDTH, loadWidth, pageTitlePaintKey, pageTitleTravel, pixel, renderScreen, type Screen } from "../src/ui/screen.ts";
import { WAVE_HOP, emptyWave, type WaveTape } from "../src/ui/wave.ts";
import { defaultUi, HOLD_MS, HOLD_TICKS, openSetMode, PAGE_TITLE_MS, PAGE_TITLE_SLIDE_MS, settleWheel, WHEEL_RELEASE_MS, type DetentHold } from "../src/ui/state.ts";
import { midiMessage, reduce, relDelta, settleTrackPeek, type Session } from "../src/ui/input.ts";
import { DETENT_CLICKS, DETENT_REST_MS, ENCODER_CLICKS_PER_TURN, KNOB_MAX_STEP_DEG, KNOB_SWEEP_DEG, knobClicksPerStep, stepKnob, writeControl } from "../src/ui/controls.ts";

function session(): Session {
  return { project: defaultProject(), ui: defaultUi(), tick: 0, playing: false };
}

/** Old one-hit rings, for pictures and phrases that need something on the grid. */
const PLACED_ROTATE = {
  kick: [0, 8],
  snare: [4, 12],
  hat: [2, 10],
  perc: [6, 14],
  bass: [0, 4],
  lead: [5, 13],
} as const;

function placeHits(project: ReturnType<typeof defaultProject>): void {
  for (const lane of ["kick", "snare", "hat", "perc", "bass", "lead"] as const) {
    const [first, second] = PLACED_ROTATE[lane];
    project.working[lane].gen1.hits = 1;
    project.working[lane].gen2.hits = 1;
    project.working[lane].gen1.rotate = first;
    project.working[lane].gen2.rotate = second;
  }
  project.working.chords.gen1.hits = 1;
}

/** White glyphs on a solid black rectangle padded by `CAPTION_OUTLINE`, and the picture everywhere else. */
function assertOutline(screen: Screen, plain: Screen, parts: { text: string; x: number; y: number }[]): void {
  const ink = new Uint8Array(WIDTH * HEIGHT);
  const plate = new Uint8Array(WIDTH * HEIGHT);
  for (const part of parts) {
    const width = lettersWidth(part.text);
    const pad = CAPTION_OUTLINE;
    for (let y = part.y - pad; y < part.y + DIGIT_H + pad; y++) {
      for (let x = part.x - pad; x < part.x + width + pad; x++) {
        if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
        plate[y * WIDTH + x] = 1;
      }
    }
    plotLetters(part.text, part.x, part.y, (px, py) => {
      if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) return;
      ink[py * WIDTH + px] = 1;
    });
  }
  let lit = 0;
  let covered = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const index = y * WIDTH + x;
      if (ink[index]) {
        assert.equal(pixel(screen, x, y), 1);
        lit++;
      } else if (plate[index]) {
        assert.equal(pixel(screen, x, y), 0);
        if (pixel(plain, x, y) === 1) covered++;
      } else if (y >= HEADER_H && y <= HEADER_H + VIZ_H - 2 && (x + y) % 2 !== 0) {
        assert.equal(pixel(screen, x, y), 0);
      } else {
        assert.equal(pixel(screen, x, y), pixel(plain, x, y));
      }
    }
  }
  assert.ok(lit > 0);
  assert.ok(covered > 0);
}

function captionAt(text: string, y = CAPTION_SINGLE_Y): { text: string; x: number; y: number } {
  return { text, x: Math.floor((WIDTH - lettersWidth(text)) / 2), y };
}

function loop(state: Session): Session {
  return reduce(state, { kind: "cc", data1: 58, data2: 127 });
}

function auxIndex(id: string): number {
  const index = pagesFor("aux").findIndex((page) => page.id === id);
  if (index < 0) throw new Error(`no aux page ${id}`);
  return index;
}

/** Press the purple step, pick a page pad, then release. */
function openAux(state: Session, page = 0): Session {
  let next = reduce(state, { kind: "note", data1: 31, data2: 127 });
  next = reduce(next, { kind: "note", data1: 92 + page, data2: 127 });
  return reduce(next, { kind: "note", data1: 31, data2: 0 });
}

/** Short press. Stays under the hold threshold, so Mute and Capture latch. */
function tapCc(state: Session, cc: number): Session {
  const down = reduce(state, { kind: "cc", data1: cc, data2: 127 });
  const up = reduce({ ...down, tick: down.tick + 10 }, { kind: "cc", data1: cc, data2: 0 });
  return { ...up, tick: state.tick };
}

function openMixer(state: Session): Session {
  return tapCc(state, 88);
}

function openDeck(state: Session): Session {
  return tapCc(state, 52);
}

function shiftTrack(state: Session, index: number): Session {
  let next = reduce(state, { kind: "cc", data1: 49, data2: 127 });
  next = reduce(next, { kind: "cc", data1: 40 + index, data2: 127 });
  next = reduce(next, { kind: "cc", data1: 40 + index, data2: 0 });
  return reduce(next, { kind: "cc", data1: 49, data2: 0 });
}

function tapTrack(state: Session, index: number): Session {
  const down = reduce(state, { kind: "cc", data1: 40 + index, data2: 127 });
  return reduce({ ...down, tick: down.tick + 10 }, { kind: "cc", data1: 40 + index, data2: 0 });
}

describe("pages and leds", () => {
  it("gives drums ten pages and bass twelve", () => {
    assert.equal(pageCount("kick"), 10);
    assert.equal(pageCount("bass"), 12);
    assert.equal(pageCount("lead"), 12);
    assert.equal(pageCount("chords"), 11);
    assert.equal(pageGroup("chords", 0), "pattern");
    assert.equal(pageGroup("chords", 1), "pattern");
    assert.equal(pageGroup("kick", 8), "fx");
    assert.equal(pageGroup("kick", 9), "fx");
    assert.equal(pageGroup("bass", 9), "sound");
    assert.equal(lanePages("bass")[8]?.title, "ATTACK / SUSTAIN");
    assert.equal(lanePages("bass")[9]?.title, "RELEASE / FLT ENV");
    assert.deepEqual(lanePages("bass")[9]?.groups, ["RELEASE", "FLT ENV"]);
    assert.equal(lanePages("bass")[9]?.bindings[4]?.label, "ENV V");
    assert.equal(pageGroup("bass", 10), "fx");
    assert.equal(pageGroup("bass", 11), "fx");
    assert.equal(pageGroup("chords", 2), "pattern");
    assert.equal(pageGroupColor("chords", 2), 3);
    assert.equal(pageGroup("chords", 3), "notes");
    assert.equal(pageGroupColor("chords", 3), 14);
    assert.equal(lanePages("chords")[0]?.title, "GENERATOR 1");
    assert.deepEqual(lanePages("chords")[0]?.groups, ["GEN 1", "SIZE"]);
    assert.equal(lanePages("chords")[0]?.bindings[4]?.label, "SIZE V");
    assert.deepEqual(lanePages("chords")[2]?.groups, ["VEL", "PRB"]);
    assert.equal(lanePages("chords")[2]?.bindings[4]?.label, "PRB V");
    assert.equal(lanePages("chords")[3]?.groups[0], "TONE");
    assert.equal(pageGroup("chords", 8), "sound");
    assert.equal(pageGroup("chords", 9), "fx");
    assert.equal(pageGroup("chords", 10), "fx");
    assert.equal(pageGroupColor("kick", 8), 9);
    assert.equal(lanePages("bass").at(-1)?.groups[0], "REV");
    assert.equal(lanePages("bass").at(-1)?.groups[1], "DLY");
    assert.equal(lanePages("bass").at(-2)?.groups[0], "FLT CUTOFF");
    assert.equal(lanePages("bass").at(-2)?.groups[1], "FLT RESO");
    assert.equal(lanePages("kick")[0].title, "BEAT GEN");
    assert.deepEqual(lanePages("kick")[0].groups, ["BEAT", "VEL"]);
    assert.deepEqual(lanePages("kick")[2].groups, ["COUNT", "RATE"]);
    assert.equal(lanePages("kick")[1].title, "ROLL GEN");
    assert.deepEqual(lanePages("kick")[1].groups, ["ROLL", "VEL"]);
    assert.equal(lanePages("kick")[3].title, "FADE / TONE");
    assert.equal(lanePages("kick")[0].bindings[3]?.label, "BEAT PRB");
    assert.equal(lanePages("kick")[2].title, "COUNT / RATE");
    assert.equal(lanePages("bass")[0].title, "GENERATOR 1");
    assert.equal(lanePages("bass")[1].title, "GENERATOR 2");
    assert.equal(lanePages("bass")[2].title, "COUNT / SPAN");
    assert.equal(lanePages("bass")[2].bindings[0]?.label, "COUNT V");
    assert.equal(lanePages("bass")[2].groups[1], "SPAN");
    assert.equal(lanePages("bass")[3].bindings[0]?.label, "PITCH V");
    assert.equal(lanePages("bass")[3].bindings[4]?.label, "OCTAVE V");
    assert.equal(lanePages("bass")[4].bindings[4]?.label, "FOLLOW");
    assert.equal(pageGroup("bass", 2), "pattern");
    assert.equal(pageGroupColor("bass", 2), pageGroupColor("bass", 0));
    assert.equal(pageGroup("bass", 3), "notes");
    assert.equal(pageGroup("lead", 2), "pattern");
    assert.equal(lanePages("kick")[0].bindings[4]?.label, "BEAT VEL V");
    const fx = pagesFor("fx");
    assert.equal(pageCount("fx"), 2);
    assert.deepEqual(fx.map((page) => page.id), ["reverb", "delay"]);
    assert.deepEqual(fx[0].groups, ["REV ROOM", "REV LIFE"]);
    assert.deepEqual(
      fx[0].bindings.map((binding) => binding?.label ?? null),
      ["SIZE", "DECAY", "AIR", null, "SPIN", "SHIM", "LEVEL", null],
    );
    assert.deepEqual(fx[0].bindings[2]?.detents, [0.5]);
    assert.deepEqual(fx[0].bindings[4]?.detents, [0]);
    assert.deepEqual(fx[0].bindings[5]?.detents, [0]);
    assert.deepEqual(fx[1].groups, ["DLY TIME", "DLY ECHO"]);
    assert.deepEqual(
      fx[1].bindings.map((binding) => binding?.label ?? null),
      ["TIME", "FEED", "TONE", "DUCK", "PING", "TAPS", "WOW", "LEVEL"],
    );
    assert.deepEqual(fx[1].bindings[2]?.detents, [0.5]);
    assert.deepEqual(fx[1].bindings[3]?.detents, [0]);
    assert.deepEqual(fx[1].bindings[4]?.detents, [0]);
    assert.deepEqual(fx[1].bindings[5]?.detents, [0]);
    assert.deepEqual(fx[1].bindings[6]?.detents, [0]);
    assert.equal(fx[0].bindings[0]?.label, "SIZE");
    assert.equal(fx[1].bindings[0]?.label, "TIME");
    assert.equal(pageGroup("fx", 0), "fx");
    assert.equal(pageGroupColor("fx", 1), 9);
    assert.equal(fx[0].bindings[0]?.store, "lane");
    assert.equal(fx[0].bindings[0]?.morph, "lerp");
    const fxScreen = renderScreen(defaultProject(), { ...defaultUi(), context: "fx" }, 0);
    assert.equal(fxScreen.viz, "none");
    assert.equal(fxScreen.header.startsWith("FX"), true);
    const aux = pagesFor("aux");
    assert.equal(pageCount("aux"), 4);
    assert.deepEqual(aux.map((page) => page.id), ["settings", "prog", "play", "bus"]);
    assert.equal(aux[0].bindings[0]?.label, "TEMPO");
    assert.equal(pageGroup("aux", 0), "global");
    assert.equal(pageGroupColor("aux", 0), 8);
    assert.equal(aux[1].bindings[0]?.label, "START");
    assert.equal(pageGroup("aux", 1), "notes");
    assert.equal(pageGroupColor("aux", 1), 14);
    assert.deepEqual(aux[2].groups, ["PLAY", "TONE"]);
    assert.deepEqual(
      aux[2].bindings.map((binding) => binding?.label),
      ["DENS", "REP", "RATE", "VEL", "CUT", "RES", "DRV", "DECAY"],
    );
    assert.equal(pageGroup("aux", 2), "macro");
    assert.equal(pageGroupColor("aux", 2), 22);
    assert.equal(aux[3].title, "BUS");
    assert.deepEqual(aux[3].groups, ["MIX", null]);
    assert.equal(pageGroup("aux", 3), "bus");
    assert.equal(pageGroupColor("aux", 3), 16);
    assert.equal(aux[3].bindings[0]?.label, "GLUE");
    assert.equal(aux[3].bindings[0]?.short, "GLU");
    assert.equal(aux[3].bindings[1]?.label, "PMP");
    assert.equal(aux[3].bindings[1]?.short, "PMP");
    assert.equal(aux[3].bindings[1]?.title, "PUMP");
    assert.equal(aux[3].bindings[2]?.label, "WIDE");
    assert.equal(aux[3].bindings[2]?.short, "WID");
    assert.equal(aux[3].bindings[3]?.label, "TLT");
    assert.equal(aux[3].bindings[3]?.short, "TLT");
    assert.equal(aux[3].bindings[3]?.title, "TILT");
    assert.equal(aux[3].bindings[4], null);
    assert.equal(aux[3].bindings[5], null);
    assert.equal(aux[3].bindings[6], null);
    assert.equal(aux[3].bindings[7], null);
    assert.equal(aux[3].bindings[0]?.store, "bus");
    assert.equal(aux[3].bindings[3]?.min, -1);
    const mix = mixerPage();
    assert.equal(mix.bindings[0]?.store, "mixer");
    assert.equal(mix.bindings[0]?.label, "KCK");
    assert.equal(mix.bindings[7]?.label, "MASTER");
    assert.equal(scopeIncludesPage("lane", "aux", 3, 0), true);
    assert.equal(scopeIncludesPage("page", "aux", 3, 3), true);
    assert.equal(scopeIncludesPage("page", "aux", 3, 0), false);
    assert.equal(scopeIncludesPage("group", "aux", 3, 2), false);
    const busScreen = renderScreen(defaultProject(), { ...defaultUi(), context: "aux", page: 3 }, 0);
    assert.equal(busScreen.header, "AUX MIX");
    assert.ok(busScreen.labels.some((label) => label.text === "GLU"));
    assert.ok(busScreen.labels.some((label) => label.text === "TLT"));
    const glue = bindingFor("bus.glue");
    assert.ok(glue);
    const turned = writeControl(defaultProject(), "aux", glue, DETENT_CLICKS + Math.ceil(knobClicksPerStep(glue)));
    assert.ok(turned.project.bus.glue >= glue.step - 1e-9);
    assert.equal(aux.some((page) => page.title === "MACRO"), false);
  });

  it("follows the lane lamp rules", () => {
    const project = defaultProject();
    assert.deepEqual(stepLed(project, "snare", "kick"), { family: "red", color: 127, blink: false });
    assert.equal(stepLed(project, "kick", "kick").blink, true);
    assert.equal(stepLed(project, "lead", "bass").family, "yellow");
    assert.equal(stepLed(project, "bass", "bass").blink, true);
    assert.equal(stepLeds(project, "fx")[7].family, "green");
    assert.equal(stepLeds(project, "fx")[7].color, 9);
    assert.equal(stepLeds(project, "fx")[7].blink, true);
    assert.equal(stepLeds(project, "kick")[7].family, "green");
    assert.equal(stepLeds(project, "kick")[7].blink, false);
    assert.equal(stepLeds(project, "aux")[8].family, "off");
    assert.equal(stepLeds(project, "aux")[15].family, "purple");
    assert.equal(stepLeds(project, "aux")[15].blink, true);
    assert.equal(stepLeds(project, "aux")[9].family, "off");
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
    assert.equal(stepLed(project, "bass", "bass").blinkTo, undefined);
    project.mute.kick = true;
    assert.equal(stepLed(project, "kick", "kick").blink, true);
    assert.equal(stepLed(project, "kick", "kick").blinkTo, undefined);
    project.lock.bass = true;
    assert.equal(stepLed(project, "bass", "bass").family, "lock");
    assert.equal(stepLed(project, "bass", "bass").blink, true);
    assert.equal(stepLed(project, "kick", "bass").family, "off");
    project.mute.bass = false;
    assert.equal(stepLed(project, "bass", "bass").family, "lock");
    assert.equal(stepLed(project, "bass", "bass").blink, true);
    project.mute.kick = false;
    project.solo.hat = true;
    assert.equal(stepLed(project, "kick", "fx").family, "green");
    assert.equal(stepLed(project, "kick", "kick").family, "red");
    assert.equal(stepLed(project, "kick", "kick").blink, true);
    assert.equal(stepLed(project, "kick", "hat").family, "red");
    assert.equal(stepLed(project, "kick", "hat").blink, false);
    assert.equal(stepLed(project, "bass", "bass").family, "lock");
    assert.equal(stepLed(project, "bass", "bass").blink, true);
    assert.equal(stepLed(project, "kick", "bass").family, "off");
  });

  it("lights mixer pads in the track colour, and leaves a row dark until it is on", () => {
    const project = defaultProject();
    const face = () => padLeds(project, "journal", { face: "mixer" });
    const heard = face();
    const lanes = ["kick", "snare", "hat", "perc", "bass", "lead", "chords"] as const;
    lanes.forEach((lane, col) => {
      assert.equal(heard[24 + col].color, stepLed(project, "aux", lane).color);
      assert.equal(heard[24 + col].color, lane === "kick" || lane === "snare" || lane === "hat" || lane === "perc" ? LED.red : LED.yellow);
      assert.equal(heard[16 + col].color, LED.off);
      assert.equal(heard[8 + col].color, LED.off);
    });
    assert.equal(heard[31].color, stepLed(project, "kick", "fx").color);
    assert.equal(heard[23].color, LED.off);
    assert.equal(heard[15].color, LED.off);

    project.mute.kick = true;
    project.solo.bass = true;
    project.lock.lead = true;
    project.mute.fx = true;
    project.lock.fx = true;
    const next = face();
    assert.equal(next[24].color, LED.off);
    assert.equal(next[25].color, LED.red);
    assert.equal(next[20].color, LED.yellow);
    assert.equal(next[13].color, LED.lock);
    assert.equal(next[12].color, LED.off);
    assert.equal(next[31].color, LED.off);
    assert.equal(next[15].color, LED.lock);
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
    assert.equal(sceneShadeStep(project, 0), 1);
    assert.equal(sceneShadeStep(project, halfTick), 2);
    assert.equal(sceneShadeStep({ ...project, morph: null }, halfTick), 0);
    project = { ...project, sets: [{ id: "set-1", name: "A", sceneIds: ["002"] }], activeSetId: "set-1", morph: null };
    const bank = padLeds(project, "set");
    assert.equal(bank[0].color, journal[1].color);
    assert.equal(bank[0].blink, true);
    assert.equal(bank[1].color, 0);
    const wheel = padLeds(project, "journal", { ...defaultUi(), wheelTouch: true });
    assert.equal(wheel[24].color, 3);
    assert.equal(wheel[24].blink, true);
    assert.equal(wheel[25].color, 3);
    assert.equal(wheel[16].color, offColor(9));
    assert.equal(wheel[0].color, shadeColor(LED.yellow, 0.2));
    assert.equal(wheel[0].blink, false);
    assert.equal(wheel[1].color, LED.yellow);
    assert.equal(wheel[1].blink, false);
    assert.equal(wheel[2].color, shadeColor(LED.yellow, 0.2));
    assert.equal(wheel[4].color, 0);
    assert.equal(wheel[4].blink, false);
    assert.equal(wheel[7].color, LED.red);
    assert.equal(wheel[7].blink, false);
    assert.equal(wheel[27].color, 3);
    assert.equal(wheel[28].color, offColor(20));
    const reset = padLeds({ ...project, randomizeIntensity: "clear" }, "journal", { ...defaultUi(), wheelTouch: true });
    assert.equal(reset[24].color, wheel[24].color);
    assert.equal(reset[24].blink, wheel[24].blink);
    assert.equal(reset[24].blinkTo, wheel[24].blinkTo);
    assert.equal(reset[25].color, wheel[25].color);
    assert.equal(reset[7].color, LED.red);
    assert.equal(reset[27].color, 3);
    const only = padLeds({ ...project, randomizeScope: "page" }, "journal", { ...defaultUi(), wheelTouch: true });
    assert.equal(only[24].color, 3);
    assert.equal(only[25].color, offColor(3));
    const bass = padLeds(project, "journal", { ...defaultUi(), wheelTouch: true, context: "bass" });
    assert.equal(bass[24].color, 3);
    assert.equal(bass[27].color, offColor(14));
    assert.equal(bass[30].color, offColor(20));
    assert.equal(bass[16].color, offColor(20));
    assert.equal(bass[17].color, offColor(20));
    assert.equal(bass[18].color, offColor(9));
    const chords = padLeds(project, "journal", { ...defaultUi(), wheelTouch: true, context: "chords" });
    assert.equal(chords[24].color, 3);
    assert.equal(chords[26].color, 3);
    assert.equal(chords[27].color, offColor(14));
    assert.equal(chords[28].color, offColor(20));
    assert.equal(chords[16].color, offColor(20));
    assert.equal(chords[17].color, offColor(9));
    const fx = padLeds({ ...defaultProject(), randomizeDepth: "generators" }, "journal", { wheelTouch: true, context: "fx", page: 0 });
    assert.equal(fx[24].color, offColor(9));
    assert.equal(fx[24].blink, true);
    assert.equal(fx[24].blinkTo, LED.off);
    assert.equal(fx[25].color, offColor(9));
    assert.equal(fx[25].blink, false);
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
    assert.deepEqual(padPackets(16, step), [
      [0x09, 0x90, 16, LED.white],
      [0x09, 0x90, 16, 66],
      [0x09, 0x99, 16, LED.red],
    ]);
    const project = { ...defaultProject(), wander: "fast" as const };
    const wheel = padLeds(project, "journal", { wheelTouch: true, context: "kick", page: 0 });
    const capture = padLeds(project, "journal", { sampleHeld: true });
    const pads = [
      [68, padLeds(project, "journal")[0]],
      [92, wheel[24]],
      [76, capture[8]],
    ] as const;
    for (const [note, lit] of pads) {
      assert.equal(lit.blink, true);
      const packets = padPackets(note, lit);
      const pulse = packets[packets.length - 1];
      assert.equal(pulse[1], 0x99);
      assert.equal(pulse[2], note);
      assert.equal(pulse[3], lit.color);
      assert.notEqual(pulse[3], 0);
      assert.ok(packets.slice(0, -1).every((packet) => packet[1] === 0x90 && packet[2] === note && packet[3] !== 0));
      if (lit.blinkTo) assert.ok(packets.some((packet) => packet[1] === 0x90 && packet[3] === lit.blinkTo));
    }
    assert.equal(capture[1].blink, false);
    assert.equal(capture[1].color, LED.yellow);
    assert.equal(capture[4].blink, false);
    assert.equal(capture[4].color, offColor(LED.purple));
    assert.equal(capture[5].color, LED.purple);
    assert.equal(capture[6].color, offColor(LED.purple));
    assert.deepEqual(capture[8], padLeds(project, "journal")[0]);
    assert.equal(capture[24].color, 0);
    assert.equal(wheel[0].blink, false);
    assert.equal(wheel[0].color, shadeColor(LED.yellow, 0.2));
    assert.equal(wheel[1].blink, false);
    assert.equal(wheel[1].color, LED.yellow);
    assert.equal(wheel[2].color, shadeColor(LED.yellow, 0.2));
    assert.equal(wheel[3].color, 0);
    assert.equal(wheel[7].color, LED.red);
    assert.equal(wheel[7].blink, false);
    assert.equal(wheel[8].blink, false);
    assert.equal(wheel[8].color, LED.purple);
    assert.equal(wheel[9].color, offColor(LED.purple));
    assert.equal(wheel[12].color, offColor(3));
    assert.equal(wheel[13].blink, false);
    assert.equal(wheel[13].color, 3);
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

  it("arms a blink with the visible colour on the pulse channel", () => {
    const led = { family: "yellow" as const, color: 3, blink: true, blinkTo: offColor(3) };
    assert.deepEqual(padPackets(92, led), [
      [0x09, 0x90, 92, LED.white],
      [0x09, 0x90, 92, offColor(3)],
      [0x09, 0x99, 92, 3],
    ]);
    const cleared = { family: "yellow" as const, color: LED.red, blink: true, blinkTo: 66 };
    assert.deepEqual(padPackets(92, cleared), [
      [0x09, 0x90, 92, LED.white],
      [0x09, 0x90, 92, 66],
      [0x09, 0x99, 92, LED.red],
    ]);
    const step = stepLed(defaultProject(), "bass", "bass");
    assert.deepEqual(padPackets(17, step), [
      [0x09, 0x90, 17, LED.white],
      [0x09, 0x90, 17, offColor(LED.yellow)],
      [0x09, 0x99, 17, LED.yellow],
    ]);
    const locked = stepLed({ ...defaultProject(), lock: { ...defaultProject().lock, bass: true } }, "bass", "bass");
    assert.deepEqual(padPackets(17, locked), [
      [0x09, 0x90, 17, LED.white],
      [0x09, 0x90, 17, 104],
      [0x09, 0x99, 17, LED.lock],
    ]);
    const dimmed = { family: "yellow" as const, color: offColor(3), blink: true, blinkTo: LED.off };
    const dimPackets = padPackets(92, dimmed);
    assert.deepEqual(dimPackets, [
      [0x09, 0x90, 92, LED.white],
      [0x09, 0x90, 92, 124],
      [0x09, 0x99, 92, offColor(3)],
    ]);
    assert.ok(dimPackets.every((packet) => packet[3] !== 0));
  });

  it("drains a full pad repaint without dropping colours or pulsing early", () => {
    const out = new Map<number, number[]>();
    for (let note = 68; note < 100; note++) offerLed(out, [0x09, 0x90, note, 0]);
    offerLed(out, [0x09, 0x90, 68, offColor(14)]);
    offerLed(out, [0x09, 0x99, 68, 14]);
    const first = takeLeds(out, 16);
    assert.equal(first.length, 16);
    assert.ok(first.every((packet) => packet[1] === 0x90));
    assert.equal(first[0][3], offColor(14));
    const second = takeLeds(out, 16);
    assert.equal(second.length, 16);
    assert.ok(second.every((packet) => packet[1] === 0x90));
    assert.deepEqual(takeLeds(out, 16), [[0x09, 0x99, 68, 14]]);

    const stopped = new Map<number, number[]>();
    offerLed(stopped, [0x09, 0x90, 68, offColor(3)]);
    offerLed(stopped, [0x09, 0x99, 68, 3]);
    dropLed(stopped, 0x99, 68);
    assert.deepEqual(takeLeds(stopped, 16), [[0x09, 0x90, 68, offColor(3)]]);
  });
});

describe("surface", () => {
  it("opens the play page of the purple step", () => {
    let state = session();
    const before = clone(state.project.working.kick);
    state = openAux(state, 2);
    assert.equal(state.ui.context, "aux");
    assert.equal(state.ui.page, 2);
    state = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 52, data2: 0 });
    assert.deepEqual(state.project.working.kick, before);
  });

  it("writes the macro into the lanes when the encoder is released", () => {
    let state = openAux(session(), 2);
    state.project.working.kick.gen1.probability = 0.5;
    state.project.working.snare.gen1.probability = 1;
    state.project.lock.snare = true;
    state.project.macros = { probability: -0.25 };
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    state = reduce(state, { kind: "note", data1: 0, data2: 0 });
    assert.equal(state.project.macros.probability, 0);
    assert.equal(state.project.working.kick.gen1.probability, 0.25);
    assert.equal(state.project.working.snare.gen1.probability, 1);
    const ret = state.ui.macroReturns[0];
    assert.ok(ret);
    assert.equal(ret.from, -0.25);
    const early = renderScreen(state.project, state.ui, 0, false, ret.untilMs - 500);
    assert.deepEqual(early.digits[0]?.amount, { kind: "big", n: 25, negative: true });
    const done = renderScreen(state.project, state.ui, 0, false, ret.untilMs);
    assert.deepEqual(done.digits[0]?.amount, { kind: "big", n: 0, negative: false });
    state = reduce(state, { kind: "note", data1: 1, data2: 127 });
    assert.deepEqual(state.ui.macroReturns, []);
  });

  it("waits until every encoder is up before writing macros back to zero", () => {
    let state = openAux(session(), 2);
    state.project.working.kick.gen1.probability = 0.5;
    state.project.working.bass.repeat = modulated(0.5);
    state.project.macros = { probability: -0.25, repeat: 0.25 };
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 72, data2: 1 });
    state = reduce(state, { kind: "note", data1: 0, data2: 0 });
    assert.equal(state.project.macros.probability, 0);
    assert.equal(state.project.macros.repeat, 0);
    assert.equal(state.project.working.kick.gen1.probability, 0.25);
    assert.ok(state.project.working.bass.repeat.value > 0.5);
    assert.equal(state.ui.macroReturns.length, 2);

    state = openAux(session(), 2);
    state.project.macros = { probability: -0.25, repeat: 0.25 };
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    state = reduce(state, { kind: "note", data1: 1, data2: 127 });
    state = reduce(state, { kind: "note", data1: 0, data2: 0 });
    assert.equal(state.project.macros.probability, -0.25);
    assert.equal(state.project.macros.repeat, 0.25);
    state = reduce(state, { kind: "note", data1: 1, data2: 0 });
    assert.equal(state.project.macros.probability, 0);
    assert.equal(state.project.macros.repeat, 0);
  });

  it("rerolls the mixer and a perf page from Capture", () => {
    let mix = openMixer(session());
    mix.project.mixer.kick = 0.5;
    const kickKnob = bindingFor("kick");
    assert.ok(kickKnob);
    mix = reduce(mix, { kind: "cc", data1: 71, data2: Math.ceil(knobClicksPerStep(kickKnob)) });
    assert.ok(mix.project.mixer.kick > 0.5);
    mix.project.mixer.kick = 0.2;
    mix = loop(mix);
    assert.notEqual(mix.project.mixer.kick, 0.2);

    let perf = openAux(session(), 2);
    assert.equal(perf.ui.context, "aux");
    assert.equal(perf.ui.page, 2);
    perf.project.macros = { probability: 0.8, cutoff: 0.8 };
    perf = reduce(perf, { kind: "cc", data1: 118, data2: 127 });
    perf = reduce(perf, { kind: "note", data1: 0, data2: 127 });
    assert.equal(perf.project.macros.probability, 0.8);
    assert.equal(perf.project.macros.cutoff, 0.8);
    const nonce = perf.project.randomizeNonce;
    perf = loop(perf);
    assert.ok(perf.project.randomizeNonce > nonce);

    let cleared = openAux(session(), 2);
    cleared.project.macros = { probability: 0.8, cutoff: 0.8, noise: 0.8 };
    cleared.project.randomizeScope = "page";
    cleared.project.randomizeIntensity = "clear";
    cleared = loop(cleared);
    assert.equal(cleared.project.randomizeScope, "page");
    assert.equal(cleared.project.randomizeIntensity, "clear");
    assert.equal(cleared.project.macros.probability, 0);
    assert.equal(cleared.project.macros.cutoff, 0);
    assert.equal(cleared.project.macros.noise, 0.8);

    let parked = openAux(session(), 1);
    parked.project.macros = { probability: 0.8, cutoff: 0.8 };
    parked.project.progression = { ...parked.project.progression, start: 7, mood: 1 };
    parked.project.global = { ...parked.project.global, tempo: 200, scale: "major" };
    parked.project.randomizeIntensity = "clear";
    parked.project.randomizeDepth = "generators";
    parked = loop(parked);
    assert.equal(parked.project.progression.start, 7);
    assert.equal(parked.project.global.tempo, 200);
    assert.equal(parked.project.global.scale, "major");
    assert.equal(parked.project.macros.probability, 0.8);

    parked.project.randomizeDepth = "values";
    parked = loop(parked);
    assert.equal(parked.project.randomizeScope, "group");
    assert.equal(parked.project.progression.start, 0);
    assert.equal(parked.project.progression.mood, 0);
    assert.equal(parked.project.global.tempo, 200);
    assert.equal(parked.project.global.scale, "major");
    assert.equal(parked.project.macros.probability, 0.8);

    parked.project.progression = { ...parked.project.progression, start: 7 };
    parked.project.randomizeScope = "page";
    parked.project.randomizeDepth = "all";
    parked.project.randomizeIntensity = "hard";
    const before = parked.project.progression.start;
    parked = loop(parked);
    assert.notEqual(parked.project.progression.start, before);
    assert.equal(parked.project.global.tempo, 200);

    parked.project.randomizeScope = "lane";
    parked.project.randomizeIntensity = "clear";
    parked = loop(parked);
    assert.equal(parked.project.macros.probability, 0);
    assert.equal(parked.project.macros.cutoff, 0);
    assert.equal(parked.project.progression.start, 0);
    assert.equal(parked.project.global.tempo, 120);
    assert.equal(parked.project.global.scale, "minor");

    let globalPage = openAux(session(), 0);
    globalPage.project.global = { ...globalPage.project.global, tempo: 90, scale: "dorian" };
    globalPage.project.progression = { ...globalPage.project.progression, start: 5 };
    globalPage.project.randomizeScope = "page";
    globalPage.project.randomizeIntensity = "clear";
    globalPage.project.randomizeDepth = "values";
    globalPage = loop(globalPage);
    assert.equal(globalPage.project.global.tempo, 120);
    assert.equal(globalPage.project.global.scale, "minor");
    assert.equal(globalPage.project.progression.start, 5);

    let shapes = openAux(session(), 3);
    shapes.project.macros = { probability: 0.8, cutoff: 0.8 };
    shapes.project.randomizeScope = "page";
    shapes.project.randomizeDepth = "generators";
    shapes.project.randomizeIntensity = "clear";
    shapes = loop(shapes);
    assert.equal(shapes.project.macros.probability, 0.8);
    assert.equal(shapes.project.macros.cutoff, 0.8);
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
    state = reduce(state, { kind: "note", data1: 31, data2: 127 });
    assert.equal(state.ui.heldContext, "aux");
    assert.equal(state.ui.context, "kick");
    const held = padLeds(state.project, "journal", state.ui);
    assert.deepEqual(held.slice(24, 32).map((led) => led.color), [8, 14, 22, 16, 0, 0, 0, 0]);
    assert.equal(held[24].blink, true);
    state = reduce(state, { kind: "note", data1: 93, data2: 127 });
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.heldContext, "aux");
    state = reduce(state, { kind: "note", data1: 31, data2: 0 });
    assert.equal(state.ui.context, "aux");
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.heldContext, null);

    const face = padLeds(state.project, "journal", { ...state.ui, wheelTouch: false });
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    const wheel = padLeds(state.project, "journal", state.ui);
    assert.equal(state.ui.wheelTouch, true);
    assert.deepEqual(wheel.slice(24, 32).map((led) => led.color), [8, 14, 22, 16, 0, 0, 0, 0]);
    assert.equal(wheel[25].blink, true);
    assert.equal(wheel[0].color, face[0].color);
    assert.notEqual(wheel[8].color, LED.purple);
  });

  it("keeps the purple page face under the jog page row", () => {
    const project = defaultProject();
    const settings = { context: "aux" as const, page: auxIndex("settings") };
    const settingsFace = padLeds(project, "journal", settings);
    const settingsWheel = padLeds(project, "journal", { ...settings, wheelTouch: true });
    assert.deepEqual(settingsWheel.slice(24, 32).map((led) => led.color), [8, 14, 22, 16, 0, 0, 0, 0]);
    assert.equal(settingsWheel[24].blink, true);
    assert.equal(settingsWheel[8].color, settingsFace[8].color);
    assert.notEqual(settingsWheel[8].color, LED.purple);
    const mixFace = padLeds(project, "journal", { face: "mixer" });
    const mix = padLeds(project, "journal", { face: "mixer", wheelTouch: true });
    assert.equal(mix[24].color, mixFace[24].color);
    assert.notEqual(mix[24].color, 0);
    assert.equal(mix[16].color, mixFace[16].color);
    assert.notEqual(mix[8].color, LED.purple);
    const deckFace = padLeds(project, "journal", { face: "deck" });
    const deckLeds = padLeds(project, "journal", { face: "deck", wheelTouch: true });
    assert.equal(deckLeds[16].color, deckFace[16].color);
    assert.notEqual(deckLeds[8].color, LED.purple);

    let held = reduce(session(), { kind: "note", data1: 31, data2: 127 });
    held = reduce(held, { kind: "note", data1: 9, data2: 127 });
    const both = padLeds(held.project, held.ui.mode, held.ui);
    assert.deepEqual(both.slice(24, 32).map((led) => led.color), [8, 14, 22, 16, 0, 0, 0, 0]);
    assert.notEqual(both[8].color, LED.purple);

    let state = openMixer(session());
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    state = reduce(state, { kind: "note", data1: 76, data2: 127 });
    assert.equal(state.project.randomizeDepth, "all");
    assert.equal(state.project.lock.kick, true);
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.face, "mixer");
    state = reduce(state, { kind: "note", data1: 92, data2: 127 });
    assert.equal(state.ui.page, 0);
    assert.equal(state.project.mute.kick, true);
    assert.equal(state.project.randomizeScope, "group");
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
    state.ui.page = 0;
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
    assert.equal(state.ui.focus?.label, "BEAT LEN");
    const screen = renderScreen(state.project, state.ui, 0);
    assert.equal(screen.header, "BEAT LENGTH");
    assert.ok(screen.labels.some((label) => label.text === "BEAT LENGTH" && label.y === TITLE_Y));
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
    assert.equal(pixel(screen, 1, PAGER_Y), 0);
    const paging = renderScreen(state.project, { ...state.ui, wheelTouch: true }, 0);
    assert.equal(pixel(paging, 0, PAGER_Y), 1);
    assert.equal(pixel(paging, 1, PAGER_Y), 1);
    assert.equal(pixel(paging, 14, PAGER_Y), 1);
    assert.equal(pixel(paging, 16, PAGER_Y), 1);
    assert.equal(pixel(paging, 17, PAGER_Y), 0);
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
    const screen = renderScreen(project, { ...openMixer({ project, ui: defaultUi(), tick: 0, playing: false }).ui, wheelTouch: true }, 0);
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
    assert.equal(pixel(screen, 0, PAGER_Y), 1);
    assert.equal(pixel(screen, 1, PAGER_Y), 0);
    assert.equal(pixel(screen, 86, PAGER_Y), 1);
    assert.equal(pixel(screen, 105, PAGER_Y), 0);
    assert.equal(pixel(screen, 106, PAGER_Y), 1);
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

  it("splits a ratchet burst so close hits do not share a column", () => {
    const project = defaultProject();
    project.working.kick.gen1.hits = 0;
    project.working.kick.gen2 = { ...project.working.kick.gen2, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.kick.ratchet.count = modulated(1);
    project.working.kick.ratchet.rate = modulated(1);
    const screen = renderScreen(project, defaultUi(), 0, false);
    assert.equal(litRuns(screen), 8);
    assert.ok(columnSpan(screen, 0) > 0);
    assert.equal(columnSpan(screen, 1), 0);
    assert.ok(columnSpan(screen, 2) > 0);
    assert.equal(columnSpan(screen, 15), 0);
  });

  it("opens a gap when swing parks a hit on the next sixteenth", () => {
    const project = defaultProject();
    project.global.swing = 1;
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 16, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    const screen = renderScreen(project, defaultUi(), 0, false);
    assert.equal(litRuns(screen), 16);
  });

  it("leaves a one pixel gap when a bass note runs into the next attack", () => {
    const project = defaultProject();
    project.global.phrase = 1;
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 8, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    project.working.bass.follow = 0;
    project.working.bass.length = modulated(1);
    const screen = renderScreen(project, { ...defaultUi(), context: "bass" }, 0, false);
    assert.ok(columnSpan(screen, 0) > 0);
    assert.ok(columnSpan(screen, 14) > 0);
    assert.equal(columnSpan(screen, 15), 0);
    assert.ok(columnSpan(screen, 16) > 0);
  });

  it("collapses same-onset overlaps so stacked notes stay one event", () => {
    const project = defaultProject();
    project.working.bass.gen1.hits = 0;
    project.working.bass.gen2 = { ...project.working.bass.gen2, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.bass.follow = 0;
    project.working.bass.length = modulated(0);
    project.working.bass.repeat = modulated(1);
    project.working.bass.step = modulated(1);
    project.working.bass.pitch = modulated(0.5);
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

  it("walks the lane playhead inside a sixteenth", () => {
    const project = defaultProject();
    const ui = { ...defaultUi(), context: "kick" as const };
    const steps = generatePhrase(project).steps.kick;
    const column = (tick: number) => playheadColumn(renderScreen(project, ui, tick, false), renderScreen(project, ui, tick, true));
    const mid = column(SIXTEENTH_TICKS / 2);
    const next = column(SIXTEENTH_TICKS);
    const expected = (tick: number) => Math.min(WIDTH - 1, Math.floor(((tick / SIXTEENTH_TICKS) * WIDTH) / steps));
    assert.equal(mid, expected(SIXTEENTH_TICKS / 2));
    assert.equal(next, expected(SIXTEENTH_TICKS));
    assert.ok(mid > 0 && mid < next);
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
    const stillSource = renderScreen(applyMorph(project, 16 * 48 - 1), ui, 0, false);
    assert.equal(runWidth(stillSource), 7);
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
    project.working.kick.gen1.hits = 1;
    project.working.kick.gen2.hits = 1;
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
    assert.equal(screen.labels.some((label) => label.text === "BEAT" && label.y === TITLE_Y), true);
    assert.equal(screen.labels.some((label) => label.text === "VEL" && label.y === TITLE_Y), true);
    assert.equal(screen.labels.some((label) => label.text.includes("PLAY") && label.y === TITLE_Y), false);
    assert.equal(screen.labels.some((label) => label.text.includes("JRN")), false);
    assert.equal(screen.labels.some((label) => label.text.includes("SET")), false);
    const genX = screen.labels.find((label) => label.text === "BEAT")?.x ?? -1;
    const velX = screen.labels.find((label) => label.text === "VEL")?.x ?? -1;
    assert.equal(genX, 1);
    assert.equal(velX, 65);
    assert.equal(screen.labels.some((label) => label.text === "00"), false);
    const quiet = loadWidth(0);
    const mid = renderScreen(project, defaultUi(), 0, true, 0, undefined, 50);
    const full = renderScreen(project, defaultUi(), 0, true, 0, undefined, 99);
    const covered = renderScreen(project, { ...defaultUi(), wheelTouch: true }, 0, true, 0, undefined, 99);
    assert.equal(quiet, 0);
    assert.equal(pixel(screen, 0, PAGER_Y), 1);
    assert.equal(pixel(screen, 1, PAGER_Y), 0);
    assert.equal(loadWidth(50), 65);
    assert.equal(pixel(mid, 63, PAGER_Y), 1);
    assert.equal(pixel(mid, 65, PAGER_Y), 0);
    assert.equal(pixel(mid, 66, PAGER_Y), 1);
    assert.equal(pixel(full, 0, PAGER_Y), 1);
    assert.equal(pixel(full, WIDTH - 1, PAGER_Y), 1);
    assert.equal(pixel(covered, 1, PAGER_Y), 1);
    assert.equal(pixel(covered, 17, PAGER_Y), 0);
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
    const turned = renderScreen(defaultProject(), { ...defaultUi(), page: 2, wheelTouch: true }, 0);
    assert.equal(pixel(turned, 1, PAGER_Y), 0);
    assert.equal(pixel(turned, 36, PAGER_Y), 1);
    assert.equal(pixel(turned, 37, PAGER_Y), 0);
    const mix = renderScreen(defaultProject(), { ...openMixer(session()).ui, wheelTouch: true }, 0);
    assert.equal(pixel(mix, 0, PAGER_Y), 1);
    assert.equal(pixel(mix, 1, PAGER_Y), 0);
    assert.equal(pixel(mix, 86, PAGER_Y), 1);
    assert.equal(pixel(mix, 105, PAGER_Y), 0);
    assert.equal(pixel(mix, 106, PAGER_Y), 1);
    assert.equal(mix.viz, "mixer");
    assert.ok(mix.labels.some((label) => label.text === "KCK" && label.y === HEIGHT - FONT_H - 1));
    const bassProject = defaultProject();
    bassProject.working.bass.pitch = modulated(0.5, 0, 8, 1);
    bassProject.working.bass.follow = 0;
    bassProject.working.bass.length = modulated(0);
    bassProject.working.bass.gen1.hits = 8;
    const pitchPage = renderScreen(defaultProject(), { ...defaultUi(), context: "bass", page: 3 }, 0);
    assert.ok(pitchPage.digits.some((digit) => digit.cell === 0 && digit.amount.kind === "big" && digit.amount.n === 50));
    assert.ok(pitchPage.digits.some((digit) => digit.cell === 4 && digit.amount.kind === "big" && digit.amount.n === 3));
    const leadPitch = renderScreen(defaultProject(), { ...defaultUi(), context: "lead", page: 3 }, 0);
    assert.ok(leadPitch.digits.some((digit) => digit.cell === 4 && digit.amount.kind === "big" && digit.amount.n === 4));
    const pitchHeld = renderScreen(defaultProject(), {
      ...defaultUi(),
      context: "bass",
      page: 3,
      focus: { label: "PITCH V", path: "pitch.value", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(pitchHeld.header, "C3");
    const lengthPage = renderScreen(defaultProject(), { ...defaultUi(), context: "bass", page: 4 }, 0);
    assert.ok(lengthPage.labels.some((label) => label.text === "FOL"));
    const bass = renderScreen(bassProject, { ...defaultUi(), context: "bass" }, 0);
    assert.ok(columnSpan(bass, 0) <= VIZ_H / 2);
    assert.ok(pitchSpread(bass) > columnSpan(bass, 0));
    const chords = renderScreen(defaultProject(), { ...defaultUi(), context: "aux", page: 1 }, 0);
    const chordNames = chords.labels.filter((label) => label.y === NAME_Y).map((label) => label.text);
    assert.deepEqual(chordNames, ["STA", "COU", "LEN", "MOT", "VAR", "MOO", "TEN", "WAY"]);
    const midi = defaultProject();
    midi.progression.count = 0;
    const held = renderScreen(midi, {
      ...defaultUi(),
      context: "aux",
      page: 1,
      focus: { label: "COUNT", path: "count", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(held.header, "MIDI");
    assert.equal(bindingFor("count")?.min, 0);
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
    project.working.chords.gen1.hits = 1;
    project.progression.count = 3;
    project.progression.length = 4;
    project.progression.variation = 0;
    const bars = renderScreen(project, { ...defaultUi(), context: "aux", page: 1 }, 0);
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
    const velPage = renderScreen(project, { ...defaultUi(), context: "chords", page: 2 }, 0);
    assert.ok(velPage.labels.some((label) => label.text === "VEL"));
    assert.ok(velPage.labels.some((label) => label.text === "PRB"));
    const tonePage = renderScreen(project, { ...defaultUi(), context: "chords", page: 3 }, 0);
    assert.match(tonePage.header, /TONE/);
    assert.match(tonePage.header, /OCTAVE/);
    const toneNames = tonePage.labels.filter((label) => label.y === NAME_Y).map((label) => label.text);
    assert.deepEqual(toneNames, ["V", "P", "C", "A", "V", "P", "C", "A"]);
    const toneHeld = renderScreen(project, {
      ...defaultUi(),
      context: "chords",
      page: 3,
      focus: { label: "TONE V", path: "tone.value", generator: "tone.value", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(toneHeld.header, "C4");
    const octaveHeld = renderScreen(project, {
      ...defaultUi(),
      context: "chords",
      page: 3,
      focus: { label: "OCTAVE V", path: "octave.value", generator: "octave.value", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(octaveHeld.header, "OCT 4");
    const zone = (rate: number) => renderScreen(
      { ...project, working: { ...project.working, chords: { ...project.working.chords, rate: modulated(rate) } } },
      { ...defaultUi(), context: "chords", page: 1, focus: { label: "RATE V", path: "rate.value", generator: "rate.value", showPattern: false, held: true, untilTick: 0, untilMs: 0 } },
      0,
    ).header;
    assert.equal(zone(0), "BLOCK");
    assert.equal(zone(0.01), "1/1");
    assert.equal(zone(0.25), "1/4");
    assert.match(zone(0.75), /^\d/);
    const ratchet = (rate: number) => renderScreen(
      { ...project, working: { ...project.working, kick: { ...project.working.kick, ratchet: { ...project.working.kick.ratchet, rate: modulated(rate) } } } },
      { ...defaultUi(), context: "kick", page: 2, focus: { label: "RATE V", path: "ratchet.rate.value", generator: "ratchet.rate", showPattern: false, held: true, untilTick: 0, untilMs: 0 } },
      0,
    ).header;
    assert.equal(ratchet(0), "1/8");
    assert.equal(ratchet(unitForIndex(1, 6)), "1/16");
    assert.equal(ratchet(1), "1/64");
    const roll = renderScreen(project, { ...defaultUi(), context: "chords", page: 3 }, 0);
    assert.equal(
      roll.labels.some((label) => label.y >= HEADER_H && label.y < HEADER_H + VIZ_H && /^[A-G]/.test(label.text)),
      false,
    );
    assert.ok(pitchSpread(roll) > 1);
    assert.equal(columnSpan(roll, 0), 1);
    const sound = renderScreen(project, { ...defaultUi(), context: "chords", page: 4 }, 0);
    assert.equal(
      sound.labels.some((label) => label.y >= HEADER_H && label.y < HEADER_H + VIZ_H && /^[A-G]/.test(label.text)),
      false,
    );
    assert.ok(pitchSpread(sound) > 1);
  });

  it("hides chord names while the randomize caption is up", () => {
    const project = defaultProject();
    project.progression.count = 4;
    project.progression.length = 4;
    project.progression.variation = 0;
    const ui = {
      ...defaultUi(),
      context: "aux" as const,
      page: 1,
      randomizeHint: { line: "depth" as const, untilMs: 1_000 },
    };
    const plain = renderScreen(project, { ...ui, randomizeHint: null }, 0);
    const shown = renderScreen(project, ui, 0, false, 0);
    assert.ok(plain.labels.some((label) => label.y >= HEADER_H && label.y < HEADER_H + VIZ_H));
    assert.equal(shown.labels.some((label) => label.y >= HEADER_H && label.y < HEADER_H + VIZ_H), false);
    assert.equal(shown.labels.some((label) => label.text === "ALL" || label.text === "GENS"), false);
    assertOutline(shown, plain, [captionAt("DEPTH", CAPTION_LANE_Y), captionAt("ALL", CAPTION_PAGE_Y)]);
  });

  it("draws sliced blocks with a gap and keeps the roll while an euclid knob is held", () => {
    const project = defaultProject();
    project.global.phrase = 1;
    project.progression.count = 1;
    project.progression.length = 4;
    project.progression.variation = 0;
    project.working.chords.rate = modulated(0);
    project.working.chords.gen1 = { ...project.working.chords.gen1, length: 16, hits: 4, rotate: 0 };
    project.working.chords.size = modulated(0.5);
    const cut = renderScreen(project, { ...defaultUi(), context: "chords", page: 0 }, 0);
    assert.equal(cut.viz, "phrase");
    assert.ok(columnSpan(cut, 0) >= 3);
    assert.equal(columnSpan(cut, 24), 0);
    assert.ok(columnSpan(cut, 32) >= 3);

    project.working.chords.size = modulated(1);
    const joined = renderScreen(project, { ...defaultUi(), context: "chords", page: 0 }, 0);
    let row = -1;
    for (let y = HEADER_H; y < HEADER_H + VIZ_H - 1; y++) {
      if (pixel(joined, 0, y) && pixel(joined, 32, y) && !pixel(joined, 31, y)) row = y;
    }
    assert.ok(row >= 0);

    const hits = renderScreen(project, {
      ...defaultUi(),
      context: "chords",
      page: 0,
      focus: { label: "G1 HIT", path: "gen1.hits", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(hits.viz, "phrase");
    assert.equal(columnSpan(hits, 0) >= 3, true);

    const size = renderScreen(project, {
      ...defaultUi(),
      context: "chords",
      page: 0,
      focus: { label: "SIZE V", path: "size.value", generator: "size", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(size.viz, "generator");
    assert.equal(size.header, "4/4");

    project.working.chords.gen1 = { ...project.working.chords.gen1, hits: 1, rotate: 14 };
    const wrapped = renderScreen(project, { ...defaultUi(), context: "chords", page: 0 }, 0);
    assert.ok(columnSpan(wrapped, 0) >= 3);
    assert.ok(columnSpan(wrapped, 112) >= 3);
  });

  it("steps ratchet count through eight repeats", () => {
    const count = bindingFor("ratchet.count.value");
    assert.ok(count);
    assert.equal(count.step, 1 / 8);
    assert.equal(count.max, 7 / 8);
    assert.ok(knobClicksPerStep(count) * (360 / ENCODER_CLICKS_PER_TURN) <= KNOB_MAX_STEP_DEG + 1e-9);
    let value = 0;
    let hold: DetentHold | null = null;
    let pending = 0;
    const toward = (target: number) => {
      let guard = 0;
      while (value < target - 1e-9 && guard++ < 500) {
        const stepped = stepKnob(value, count, 1, hold, 0, pending);
        value = stepped.value;
        hold = stepped.hold;
        pending = stepped.pending;
      }
    };
    toward(0.125);
    assert.equal(value, 0.125);
    toward(0.875);
    assert.equal(value, 0.875);
    assert.equal(stepKnob(0.875, count, 1, null).value, 0.875);
    const project = defaultProject();
    const digit = (value: number) => {
      project.working.kick.ratchet.count = modulated(value);
      const screen = renderScreen(project, { ...defaultUi(), page: 2 }, 0);
      return screen.digits.find((item) => item.cell === 0)?.amount;
    };
    assert.deepEqual(digit(0), { kind: "big", n: 1, negative: false });
    assert.deepEqual(digit(0.4), { kind: "big", n: 4, negative: false });
    assert.deepEqual(digit(1), { kind: "big", n: 8, negative: false });
    project.working.kick.ratchet.count = modulated(0.5);
    const held = renderScreen(project, {
      ...defaultUi(),
      page: 2,
      focus: { label: "COUNT V", path: "ratchet.count.value", generator: "ratchet.count", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(held.header, "5");
  });

  it("names a roll gesture while its value is held", () => {
    const project = defaultProject();
    const header = (path: string, value: number) => {
      const key = path.endsWith("fade.value") ? "fade" as const : "tone" as const;
      project.working.kick.ratchet[key] = modulated(value);
      return renderScreen(project, {
        ...defaultUi(),
        page: 3,
        focus: { label: path, path, generator: path.slice(0, -6), showPattern: false, held: true, untilTick: 0, untilMs: 0 },
      }, 0).header;
    };
    assert.equal(header("ratchet.fade.value", 0.5), "FLAT");
    assert.equal(header("ratchet.fade.value", 0), "FALL");
    assert.equal(header("ratchet.fade.value", 1), "RISE");
    assert.equal(header("ratchet.tone.value", 0.5), "FLAT");
    assert.equal(header("ratchet.tone.value", 0), "DOWN");
    assert.equal(header("ratchet.tone.value", 1), "UP");
  });

  it("names the run span in scale degrees while its value is held", () => {
    const project = defaultProject();
    const header = (value: number) => {
      project.working.bass.step = modulated(value);
      return renderScreen(project, {
        ...defaultUi(),
        context: "bass",
        page: 2,
        focus: { label: "SPAN V", path: "step.value", generator: "step", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
      }, 0).header;
    };
    assert.equal(header(0.5), "0");
    assert.equal(header(1), "+7");
    assert.equal(header(0), "-7");
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
    const global = renderScreen(defaultProject(), { ...defaultUi(), context: "aux", page: 0 }, 0);
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
      page: 0,
      focus: { label: "SCALE", path: "scale", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.ok(mode.labels.some((label) => label.y === VALUE_Y && label.text === "D" && label.cell === 2));
    assert.ok(mode.labels.some((label) => label.y === TITLE_Y && label.text === "DORIAN"));
  });

  it("draws a 1/x division as one big denominator", () => {
    for (const label of [...RATES.map((rate) => rate.id), ...CHORD_RATES.map((rate) => rate.id), ...DIV_LABEL, ...BRAKE_LABEL]) {
      const amount = fractionFromLabel(label);
      assert.ok(amount, label);
      if (amount.num === 1) assert.ok(amount.den <= 99, label);
    }

    const big = (screen: Screen, cell: number) => screen.digits.find((digit) => digit.cell === cell)?.amount;
    const project = defaultProject();
    const kick = renderScreen(project, { ...defaultUi(), context: "kick", page: 2 }, 0);
    assert.deepEqual(big(kick, 4), { kind: "big", n: 8, negative: false });
    project.working.kick.ratchet.rate = modulated(unitForIndex(1, 6));
    const sixteenth = renderScreen(project, { ...defaultUi(), context: "kick", page: 2 }, 0);
    assert.deepEqual(big(sixteenth, 4), { kind: "big", n: 16, negative: false });
    project.working.kick.ratchet.rate = modulated(unitForIndex(2, 6));
    const triplet = renderScreen(project, { ...defaultUi(), context: "kick", page: 2, focus: { label: "RATE V", path: "ratchet.rate.value", generator: "ratchet.rate", showPattern: false, held: true, untilTick: 0, untilMs: 0 } }, 0);
    assert.deepEqual(big(triplet, 4), { kind: "big", n: 16, negative: false });
    assert.equal(triplet.labels.some((label) => label.cell === 4 && label.text.includes("T")), false);
    assert.equal(triplet.header, "1/16T");

    const chords = defaultProject();
    const block = renderScreen(
      { ...chords, working: { ...chords.working, chords: { ...chords.working.chords, rate: modulated(0) } } },
      { ...defaultUi(), context: "chords", page: 1, focus: { label: "RATE V", path: "rate.value", generator: "rate.value", showPattern: false, held: true, untilTick: 0, untilMs: 0 } },
      0,
    );
    assert.equal(block.header, "BLOCK");
    assert.equal(block.labels.some((label) => label.text === "BLK" && label.cell === 0 && label.y === VALUE_Y), true);
    assert.equal(block.digits.some((digit) => digit.cell === 0), false);
    const arp = renderScreen(
      { ...chords, working: { ...chords.working, chords: { ...chords.working.chords, rate: modulated(0.01) } } },
      { ...defaultUi(), context: "chords", page: 1 },
      0,
    );
    assert.deepEqual(big(arp, 0), { kind: "big", n: 1, negative: false });
  });

  it("draws delay time as the note it plays", () => {
    const held = { label: "TIME", path: "delay.time", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 };
    const eighth = renderScreen(defaultProject(), { ...defaultUi(), context: "fx", page: 1, focus: held }, 0);
    assert.equal(eighth.header, "1/8");
    assert.deepEqual(eighth.digits.find((digit) => digit.cell === 0)?.amount, { kind: "big", n: 8, negative: false });
    const project = defaultProject();
    project.working.fx.delay.time = 0;
    const thirty = renderScreen(project, { ...defaultUi(), context: "fx", page: 1 }, 0);
    assert.deepEqual(thirty.digits.find((digit) => digit.cell === 0)?.amount, { kind: "big", n: 32, negative: false });
    project.working.fx.delay.time = 0.6;
    const quarter = renderScreen(project, { ...defaultUi(), context: "fx", page: 1, focus: held }, 0);
    assert.equal(quarter.header, "1/4");
    assert.deepEqual(quarter.digits.find((digit) => digit.cell === 0)?.amount, { kind: "big", n: 4, negative: false });
    project.working.fx.delay.time = 1;
    const bar = renderScreen(project, { ...defaultUi(), context: "fx", page: 1, focus: held }, 0);
    assert.equal(bar.header, "1/1");
    assert.deepEqual(bar.digits.find((digit) => digit.cell === 0)?.amount, { kind: "big", n: 1, negative: false });
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
    assert.equal(phrase.header, "BEAT HITS");
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
    assert.equal(waiting.header, "1");
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
    assert.equal(next.header, "KCK FADE TONE");
    assert.ok(next.labels.some((label) => label.text === "FADE"));

    let held = session();
    held = reduce(held, { kind: "cc", data1: 14, data2: 1 });
    held = reduce(held, { kind: "cc", data1: 14, data2: 1 });
    held = reduce(held, { kind: "note", data1: 0, data2: 127 });
    assert.equal(renderScreen(held.project, held.ui, 0).viz, "generator");
    held = reduce(held, { kind: "cc", data1: 14, data2: 1 });
    const left = renderScreen(held.project, held.ui, 0);
    assert.equal(held.ui.focus, null);
    assert.equal(left.viz, "phrase");
    assert.equal(left.header, "KCK FADE TONE");
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

  it("names a voice source and drops the cycle ticks", () => {
    const project = defaultProject();
    project.working.kick.filter.cutoff = { value: 0, pattern: -1, cycle: 4, amount: 0 };
    const named = renderScreen(project, {
      ...defaultUi(),
      context: "kick",
      page: 8,
      focus: { label: "CUTOFF P", path: "filter.cutoff.pattern", generator: "filter.cutoff", showPattern: true, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.ok(named.labels.some((label) => label.text === "KCK" && label.cell === 1));
    assert.equal(named.labels.some((label) => label.cell === 2), false);
    const flat = {
      ...defaultUi(),
      context: "kick" as const,
      page: 8,
      focus: { label: "CUTOFF V", path: "filter.cutoff.value", generator: "filter.cutoff", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    };
    const screen = renderScreen(project, flat, 0);
    assert.equal(pixel(screen, 0, HEADER_H), 0);
    assert.equal(pixel(screen, 32, HEADER_H), 0);
    const playing = renderScreen(project, flat, 0, true);
    assert.equal(pixel(playing, 0, HEADER_H), 1);
  });

  it("draws a voice envelope across the lane", () => {
    const project = defaultProject();
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    project.working.kick.filter.cutoff = { value: 0, pattern: -1, cycle: 4, amount: 1 };
    const ui = {
      ...defaultUi(),
      context: "kick" as const,
      page: 8,
      focus: { label: "CUTOFF V", path: "filter.cutoff.value", generator: "filter.cutoff", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    };
    const screen = renderScreen(project, ui, 0);
    const yTop = HEADER_H;
    const yBottom = HEADER_H + VIZ_H - 2;
    assert.equal(pixel(screen, 0, yTop), 1);
    assert.equal(pixel(screen, WIDTH - 1, yTop), 0);
    assert.equal(pixel(screen, WIDTH - 1, yBottom), 1);
  });

  it("draws a voice envelope for a generator the phrase does not stamp", () => {
    const project = defaultProject();
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 1, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    project.working.kick.ratchet.count = { value: 0, pattern: -1, cycle: 4, amount: 1 };
    const screen = renderScreen(project, {
      ...defaultUi(),
      context: "kick" as const,
      focus: { label: "COUNT V", path: "ratchet.count.value", generator: "ratchet.count", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    const yTop = HEADER_H;
    const yBottom = HEADER_H + VIZ_H - 2;
    assert.equal(pixel(screen, 0, yTop), 1);
    assert.equal(pixel(screen, WIDTH - 1, yBottom), 1);
  });

  it("draws a generator over the phrase and darkens the phrase with a 1px checker", () => {
    const project = defaultProject();
    placeHits(project);
    const phrase = renderScreen(project, defaultUi(), 0);
    const over = renderScreen(project, {
      ...defaultUi(),
      focus: { label: "COUNT V", path: "ratchet.count.value", generator: "ratchet.count", showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(over.viz, "generator");
    const yTop = HEADER_H;
    const yBottom = HEADER_H + VIZ_H - 2;
    let punched = 0;
    for (let y = yTop + 2; y < yBottom; y++) {
      for (let x = 0; x < 128; x++) {
        if (!pixel(phrase, x, y)) {
          assert.equal(pixel(over, x, y), 0);
          continue;
        }
        const kept = (x + y) % 2 === 0;
        assert.equal(pixel(over, x, y), kept ? 1 : 0);
        if (!kept) punched++;
      }
    }
    assert.ok(punched > 0);
    for (let x = 0; x < 128; x++) assert.equal(pixel(over, x, yBottom), 1);
  });

  it("keeps the jog layer through a contact bounce and drops it after the release window", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    state = reduce(state, { kind: "note", data1: 9, data2: 0 });
    assert.equal(state.ui.wheelTouch, true);
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    assert.equal(state.ui.wheelTouch, true);
    assert.equal(state.ui.wheelReleaseMs, null);
    state = reduce(state, { kind: "note", data1: 9, data2: 0 });
    const released = state.ui.wheelReleaseMs ?? 0;
    assert.equal(settleWheel(state.ui, released + WHEEL_RELEASE_MS - 1).wheelTouch, true);
    const settled = settleWheel(state.ui, released + WHEEL_RELEASE_MS);
    assert.equal(settled.wheelTouch, false);
    assert.equal(settled.wheelReleaseMs, null);
  });

  it("keeps the randomize pads after a jog click", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 3, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 3, data2: 0 });
    state = reduce(state, { kind: "note", data1: 9, data2: 0 });
    const released = state.ui.wheelReleaseMs ?? 0;
    state = { ...state, ui: settleWheel(state.ui, released + WHEEL_RELEASE_MS) };
    assert.equal(state.ui.wheelTouch, false);
    assert.equal(state.ui.randomizeLatched, true);
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "phrase");
    assert.equal(padLeds(state.project, state.ui.mode, state.ui)[8].color, LED.purple);
    state = reduce(state, { kind: "cc", data1: 3, data2: 127 });
    assert.equal(state.ui.randomizeLatched, false);
    assert.equal(padLeds(state.project, state.ui.mode, state.ui)[8].color, 0);
  });

  it("parks the randomize latch on the purple lane and restores it on any other", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 3, data2: 127 });
    state = reduce(state, { kind: "note", data1: 31, data2: 127 });
    assert.equal(state.ui.heldContext, "aux");
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.randomizeLatched, false);
    assert.equal(state.ui.randomizeParked, true);
    assert.equal(padLeds(state.project, state.ui.mode, state.ui)[24].color, 8);
    assert.notEqual(padLeds(state.project, state.ui.mode, state.ui)[8].color, LED.purple);
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    assert.equal(state.ui.heldContext, "kick");
    assert.equal(state.ui.randomizeLatched, true);
    assert.equal(state.ui.randomizeParked, null);

    state = reduce(state, { kind: "note", data1: 16, data2: 0 });
    state = openAux(state, 0);
    assert.equal(state.ui.randomizeLatched, false);
    assert.equal(state.ui.randomizeParked, true);
    state = reduce(state, { kind: "cc", data1: 3, data2: 127 });
    assert.equal(state.ui.randomizeLatched, false);
    assert.equal(state.ui.randomizeParked, false);
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce(state, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.randomizeLatched, false);
    assert.equal(state.ui.randomizeParked, null);
    assert.equal(padLeds(state.project, state.ui.mode, state.ui)[8].color, 0);
  });

  it("gives mixer and dj their own pads, and a step leaves the latch", () => {
    let state = openMixer(session());
    const held = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(held[24].color, LED.red);
    assert.equal(held[16].color, LED.off);
    assert.equal(held[8].color, LED.off);
    state = reduce(state, { kind: "note", data1: 84, data2: 127 });
    assert.equal(state.project.solo.kick, true);
    state = reduce(state, { kind: "note", data1: 31, data2: 127 });
    assert.equal(state.ui.face, null);
    assert.equal(state.ui.heldContext, "aux");
    assert.equal(padLeds(state.project, state.ui.mode, state.ui)[24].color, 8);
    state = reduce(state, { kind: "note", data1: 31, data2: 0 });
    assert.equal(state.ui.context, "aux");
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "none");

    state = openDeck(session());
    const deck = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(state.ui.face, "deck");
    assert.equal(state.ui.context, "kick");
    assert.equal(deck[16].color, offColor(9));
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce(state, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.face, null);
    assert.equal(state.ui.context, "kick");
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "phrase");
  });

  it("hides the Sample row while the randomize view is showing", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 3, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 3, data2: 0 });
    state = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 118, data2: 0 });
    assert.equal(state.ui.randomizeLatched, true);
    assert.equal(state.ui.sampleLatched, true);
    const covered = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(covered[8].color, LED.purple);
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.equal(state.project.randomizeIntensity, "soft");
    assert.equal(state.project.transition, "fast");
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    assert.equal(padLeds(state.project, state.ui.mode, state.ui)[8].color, LED.purple);
    state = reduce(state, { kind: "cc", data1: 3, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 3, data2: 0 });
    state = reduce(state, { kind: "note", data1: 9, data2: 0 });
    const released = state.ui.wheelReleaseMs ?? 0;
    state = { ...state, ui: settleWheel(state.ui, released + WHEEL_RELEASE_MS) };
    assert.equal(state.ui.randomizeLatched, false);
    assert.equal(state.ui.wheelTouch, false);
    const patterns = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(patterns[1].color, LED.yellow);
    assert.equal(patterns[4].color, LED.purple);
  });

  it("sets transition and clears wander from the Sample row", () => {
    let state = session();
    placeHits(state.project);
    state = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68, data2: 127 });
    assert.equal(state.project.transition, "now");
    const now = (state.ui.sampleHint?.untilMs ?? 0) - 1;
    const chosen = renderScreen(state.project, state.ui, 0, false, now);
    const chosenBare = renderScreen(state.project, { ...state.ui, sampleHint: null }, 0, false, now);
    assert.equal(chosen.viz, "phrase");
    assert.equal(chosen.labels.some((label) => label.text === "TRANS" || label.text === "NOW"), false);
    assertOutline(chosen, chosenBare, [captionAt("TRANSITION", CAPTION_LANE_Y), captionAt("NOW", CAPTION_PAGE_Y)]);
    const gone = renderScreen(state.project, state.ui, 0, false, state.ui.sampleHint?.untilMs ?? 0);
    assert.deepEqual(gone.pixels, chosenBare.pixels);
    state = reduce(state, { kind: "note", data1: 73, data2: 127 });
    assert.equal(state.project.wander, "fast");
    state = reduce(state, { kind: "note", data1: 73, data2: 127 });
    assert.equal(state.project.wander, "fast");
    state = reduce(state, { kind: "note", data1: 72, data2: 127 });
    assert.equal(state.project.wander, null);
    const at = (state.ui.sampleHint?.untilMs ?? 0) - 1;
    const screen = renderScreen(state.project, state.ui, 0, false, at);
    const bare = renderScreen(state.project, { ...state.ui, sampleHint: null }, 0, false, at);
    assert.equal(screen.viz, "phrase");
    assert.equal(screen.labels.some((label) => label.text === "WANDER" || label.text === "OFF"), false);
    assertOutline(screen, bare, [captionAt("WANDER", CAPTION_LANE_Y), captionAt("OFF", CAPTION_PAGE_Y)]);
    assert.equal(screen.header.includes("T:"), false);
  });

  it("records, mutes, captures, and stores a track bookmark", () => {
    let state = session();
    state = reduce(state, { kind: "cc", data1: 86, data2: 127 });
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
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "phrase");
    state = loop(state);
    assert.notDeepEqual(state.project.working.kick.gen1, beforeGen1);
    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 40, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 40, data2: 0 });
    state = reduce(state, { kind: "cc", data1: 49, data2: 0 });
    assert.deepEqual(state.project.bookmarks[0], { context: "kick", page: 0 });
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[0].color, pageGroupColor("kick", 0));
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[0].blink, true);
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[1].color, 0);
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    state = reduce({ ...state, tick: state.tick + 10 }, { kind: "note", data1: 20, data2: 0 });
    for (let n = 0; n < 6; n++) state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 41, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 41, data2: 0 });
    state = reduce(state, { kind: "cc", data1: 49, data2: 0 });
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

  it("returns from a short track press and from a long hold", () => {
    let state = shiftTrack(session(), 0);
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    state = reduce(state, { kind: "note", data1: 20, data2: 0 });
    for (let n = 0; n < 3; n++) state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "cc", data1: 50, data2: 127 });
    assert.equal(state.ui.context, "bass");
    assert.equal(state.ui.page, 3);
    assert.equal(state.ui.mode, "set");

    state = tapTrack(state, 0);
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.page, 0);
    assert.equal(state.ui.mode, "set");
    assert.equal(state.ui.trackLatch, 0);
    state = reduce(state, { kind: "cc", data1: 50, data2: 127 });
    assert.equal(state.ui.mode, "journal");

    state = tapTrack(state, 0);
    assert.equal(state.ui.context, "bass");
    assert.equal(state.ui.page, 3);
    assert.equal(state.ui.mode, "set");
    assert.equal(state.ui.trackLatch, null);

    const held = reduce(state, { kind: "cc", data1: 40, data2: 127 });
    const peeked = settleTrackPeek(held, (held.ui.trackDownMs[0] ?? 0) + HOLD_MS);
    assert.equal(peeked.ui.context, "kick");
    assert.equal(peeked.ui.page, 0);
    assert.equal(peeked.ui.mode, "set");
    assert.equal(peeked.ui.trackPeek, 0);
    state = reduce(peeked, { kind: "cc", data1: 40, data2: 0 });
    assert.equal(state.ui.context, "bass");
    assert.equal(state.ui.page, 3);
    assert.equal(state.ui.mode, "set");
    assert.equal(state.ui.trackLatch, null);
    assert.equal(state.ui.trackPeek, null);

    state = tapTrack(state, 3);
    assert.equal(state.ui.context, "bass");
    assert.equal(state.ui.page, 3);
    assert.equal(state.project.bookmarks[3], null);
  });

  it("stores purple-lane pages and matches the page pad colour", () => {
    for (const item of pagesFor("aux")) {
      const page = auxIndex(item.id);
      let state = shiftTrack(openAux(session(), page), 2);
      assert.equal(state.ui.context, "aux");
      assert.equal(state.ui.page, page);
      assert.deepEqual(state.project.bookmarks[2], { context: "aux", page });
      const pad = padLeds(state.project, state.ui.mode, { heldContext: "aux", heldPage: page, context: "aux", page });
      assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[2].color, pad[24 + page]?.color);
      assert.equal(pad[24 + page]?.color, pageGroupColor("aux", page));
      state = reduce(state, { kind: "note", data1: 16, data2: 127 });
      state = reduce(state, { kind: "note", data1: 16, data2: 0 });
      assert.equal(state.ui.context, "kick");
      assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[2].color, pageGroupColor("aux", page));
      assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[2].blink, false);
      state = tapTrack(state, 2);
      assert.equal(state.ui.context, "aux");
      assert.equal(state.ui.page, page);
      state = tapTrack(state, 2);
      assert.equal(state.ui.context, "kick");
      assert.equal(state.ui.page, 0);
    }

    const mixer = auxIndex("bus");
    let held = openAux(session(), mixer);
    held = reduce(held, { kind: "note", data1: 16, data2: 127 });
    held = reduce(held, { kind: "note", data1: 16, data2: 0 });
    assert.equal(held.ui.lanePages.aux, mixer);
    held = reduce(held, { kind: "note", data1: 31, data2: 127 });
    assert.equal(held.ui.context, "kick");
    assert.equal(held.ui.heldContext, "aux");
    held = shiftTrack(held, 1);
    assert.deepEqual(held.project.bookmarks[1], { context: "aux", page: mixer });
    assert.equal(held.ui.context, "kick");
    assert.equal(held.ui.heldContext, "aux");
    const saved = parseStored(serializeStored(held.project, { context: held.ui.context, page: held.ui.page, mode: held.ui.mode, playing: false, sampleLatched: false }));
    assert.deepEqual(saved?.project.bookmarks[1], { context: "aux", page: mixer });
    held = reduce(held, { kind: "note", data1: 31, data2: 0 });
    assert.equal(held.ui.context, "aux");
    assert.equal(held.ui.page, mixer);
  });

  it("clears a track bookmark with Delete and leaves the screen", () => {
    let state = shiftTrack(session(), 1);
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    state = reduce(state, { kind: "note", data1: 20, data2: 0 });
    state = shiftTrack(state, 0);
    assert.deepEqual(state.project.bookmarks[0], { context: "bass", page: 0 });
    assert.deepEqual(state.project.bookmarks[1], { context: "kick", page: 0 });

    state = reduce(state, { kind: "cc", data1: 119, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 40, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 40, data2: 0 });
    assert.equal(state.project.bookmarks[0], null);
    assert.deepEqual(state.project.bookmarks[1], { context: "kick", page: 0 });
    assert.equal(state.ui.context, "bass");
    assert.equal(state.ui.page, 0);
    assert.equal(trackLeds(state.project, state.ui.context, state.ui.page)[0].color, 0);
    assert.equal(state.ui.trackLatch, null);
    state = reduce(state, { kind: "cc", data1: 119, data2: 0 });

    state = tapTrack(state, 1);
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.trackLatch, 1);
    state = reduce(state, { kind: "cc", data1: 119, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 41, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 41, data2: 0 });
    assert.equal(state.project.bookmarks[1], null);
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.page, 0);
    assert.equal(state.ui.trackLatch, null);
    state = reduce(state, { kind: "cc", data1: 119, data2: 0 });
    state = tapTrack(state, 1);
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.page, 0);
  });

  it("writes the encoder while Sample is held", () => {
    let state = session();
    const before = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    assert.deepEqual(state.project.working.kick, before);
    const length = bindingFor("gen1.length");
    assert.ok(length);
    const extra = Math.ceil(knobClicksPerStep(length) - 1e-9);
    for (let n = 0; n < DETENT_CLICKS + extra; n++) state = reduce(state, { kind: "cc", data1: 71, data2: 1 });
    assert.equal(state.project.working.kick.gen1.length, before.gen1.length + 1);
    assert.deepEqual(state.project.working.kick.gen2, before.gen2);
    state = reduce(state, { kind: "cc", data1: 118, data2: 0 });
    assert.equal(state.ui.sampleHeld, false);
    assert.equal(state.project.working.kick.gen1.length, before.gen1.length + 1);
  });

  it("rerolls the whole lane when scope is lane, and Shift does not widen it", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 12, data2: 127 });
    assert.equal(state.project.randomizeScope, "lane");
    const parked = clone(state.project.working.kick);

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
    for (let n = 0; n < 8; n++) fx = reduce(fx, { kind: "cc", data1: 14, data2: 1 });
    const open = fx.project.working.kick;
    fx = loop(fx);
    assert.equal(fx.ui.page, 8);
    assert.notDeepEqual(fx.project.working.kick.filter, open.filter);
    assert.deepEqual(fx.project.working.kick.sound, open.sound);
    assert.deepEqual(fx.project.working.kick.gen1, open.gen1);
  });

  it("treats fx knobs as values: generators leaves them, values and delete move them", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 23, data2: 127 });
    state = reduce({ ...state, tick: state.tick + 20 }, { kind: "note", data1: 23, data2: 0 });
    assert.equal(state.ui.context, "fx");
    const parked = clone(state.project.working.fx);
    state.project.randomizeDepth = "generators";
    state = loop(state);
    assert.deepEqual(state.project.working.fx, parked);

    state.project.randomizeDepth = "values";
    state.project.randomizeScope = "page";
    const delay = clone(state.project.working.fx.delay);
    state = loop(state);
    assert.notDeepEqual(state.project.working.fx.reverb, parked.reverb);
    assert.deepEqual(state.project.working.fx.delay, delay);

    state.project.working.fx.reverb.size = 0;
    state.project.working.fx.delay.time = 0;
    state.project.randomizeScope = "lane";
    state.project.randomizeIntensity = "clear";
    state = loop(state);
    assert.equal(state.project.working.fx.reverb.size, defaultProject().working.fx.reverb.size);
    assert.equal(state.project.working.fx.delay.time, defaultProject().working.fx.delay.time);
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

  it("writes one randomize row over the phrase for a second after its pad", () => {
    let state = session();
    placeHits(state.project);
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    assert.equal(state.ui.wheelTouch, true);
    const pads = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(pads[24].color, 3);
    assert.equal(pads[24].blink, true);
    assert.equal(pads[24].blinkTo, offColor(3));
    assert.equal(pads[25].color, 3);
    assert.equal(pads[25].blink, false);
    assert.equal(pads[27].color, 3);
    assert.equal(pads[27].blink, false);
    assert.equal(pads[17].color, offColor(9));
    assert.equal(pads[0].color, shadeColor(LED.yellow, 0.2));
    assert.equal(pads[0].blink, false);
    assert.equal(pads[1].color, LED.yellow);
    assert.equal(pads[1].blink, false);
    assert.equal(pads[2].color, shadeColor(LED.yellow, 0.2));
    assert.equal(pads[2].blink, false);
    assert.equal(pads[3].color, 0);
    assert.equal(pads[3].blink, false);
    assert.equal(pads[4].color, 0);
    assert.equal(pads[5].color, 0);
    assert.equal(pads[7].color, LED.red);
    assert.equal(pads[7].blink, false);
    assert.equal(pads[8].color, LED.purple);
    assert.equal(pads[8].blink, false);
    assert.equal(pads[9].color, offColor(LED.purple));
    assert.equal(pads[9].blink, false);
    assert.equal(pads[10].color, offColor(LED.purple));
    assert.equal(pads[11].color, 0);
    assert.equal(pads[12].color, offColor(3));
    assert.equal(pads[12].blink, false);
    assert.equal(pads[13].color, 3);
    assert.equal(pads[13].blink, false);
    assert.equal(pads[14].color, offColor(3));
    assert.equal(pads[14].blink, false);

    const touched = renderScreen(state.project, state.ui, 0);
    assert.equal(touched.viz, "phrase");
    assert.equal(touched.labels.some((label) => label.text === "ALL"), false);

    const before = clone(state.project.working.kick);
    state = reduce(state, { kind: "note", data1: 68 + 24, data2: 127 });
    assert.equal(state.ui.page, 0);
    assert.equal(state.ui.randomizeHint, null);
    assert.deepEqual(state.project.working.kick, before);

    state = reduce(state, { kind: "note", data1: 68 + 9, data2: 127 });
    assert.equal(state.project.randomizeDepth, "generators");
    const heldAt = (state.ui.randomizeHint?.untilMs ?? 0) - 1;
    const heldCaption = renderScreen(state.project, state.ui, 0, false, heldAt);
    const heldBare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null, randomizeHint: null }, 0, false, heldAt);
    assertOutline(heldCaption, heldBare, [captionAt(pagesFor("kick")[0]?.title ?? "")]);
    state = reduce(state, { kind: "note", data1: 9, data2: 0 });
    const upAt = state.ui.wheelReleaseMs ?? 0;
    state = { ...state, ui: settleWheel(state.ui, upAt + WHEEL_RELEASE_MS) };
    assert.equal(state.ui.wheelTouch, false);
    const at = Math.max(state.ui.pageTitleUntilMs ?? 0, upAt);
    const shown = renderScreen(state.project, state.ui, 0, false, at);
    const plain = renderScreen(state.project, { ...state.ui, randomizeHint: null }, 0, false, at);
    assert.equal(shown.viz, "phrase");
    assert.equal(shown.labels.some((label) => ["ALL", "GENS", "VALUES", "LANE", "GROUP", "PAGE", "DELETE", "LOW", "MED", "HIGH"].includes(label.text)), false);
    assert.ok(at < (state.ui.randomizeHint?.untilMs ?? 0));
    assertOutline(shown, plain, [captionAt("DEPTH", CAPTION_LANE_Y), captionAt("GENERATORS", CAPTION_PAGE_Y)]);
    const gone = renderScreen(state.project, state.ui, 0, false, state.ui.randomizeHint?.untilMs ?? 0);
    assert.deepEqual(gone.pixels, plain.pixels);
    const parked = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 3, data2: 127 });
    state = reduce(state, { kind: "note", data1: 9, data2: 0 });
    const released = state.ui.wheelReleaseMs ?? 0;
    state = { ...state, ui: settleWheel(state.ui, released + WHEEL_RELEASE_MS) };
    assert.equal(state.ui.randomizeLatched, true);
    assert.equal(state.ui.wheelTouch, false);
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "phrase");
    assert.deepEqual(state.project.working.kick, parked);

    state = reduce(state, { kind: "note", data1: 68 + 14, data2: 127 });
    assert.equal(state.project.randomizeScope, "page");
    state = loop(state);
    assert.equal(state.ui.page, 0);
    assert.equal(state.ui.randomizeLatched, true);
    assert.equal(state.project.working.kick.gen1.velocity.value, parked.gen1.velocity.value);
    assert.deepEqual(state.project.working.kick.sound, parked.sound);

    state = reduce(state, { kind: "note", data1: 68 + 13, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 8, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 0, data2: 127 });
    assert.equal(state.project.randomizeScope, "group");
    assert.equal(state.project.randomizeDepth, "all");
    assert.equal(state.project.randomizeIntensity, "soft");
    assert.equal(state.ui.notice, null);
    const softPads = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(softPads[0].color, LED.yellow);
    assert.equal(softPads[0].blink, false);
    assert.equal(softPads[7].color, LED.red);
    assert.equal(softPads[7].blink, false);
    assert.equal(softPads[24].color, 3);
    assert.equal(softPads[24].blink, true);
    assert.equal(softPads[24].blinkTo, offColor(3));
    assert.equal(softPads[25].color, 3);
    assert.equal(softPads[25].blink, false);

    state.project.working.kick.sound.pitch = modulated(0.55, 9, 6, 0.4);
    const soundBefore = clone(state.project.working.kick.sound);
    for (let n = 0; n < 4; n++) state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    state = reduce(state, { kind: "note", data1: 68 + 7, data2: 127 });
    assert.equal(state.project.randomizeIntensity, "soft");
    assert.equal(state.project.working.kick.sound.pitch.value, 0.12);
    assert.equal(state.project.working.kick.sound.pitch.pattern, 0);
    assert.equal(state.project.working.kick.sound.pitch.amount, 0);
    assert.equal(state.project.working.kick.sound.pitch.cycle, 1);
    assert.notDeepEqual(state.project.working.kick.sound, soundBefore);
  });

  it("latches a short tap and rerolls only from Loop", () => {
    let state = session();
    const before = clone(state.project.working.kick);
    state = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 118, data2: 0 });
    assert.equal(state.ui.sampleLatched, true);
    assert.equal(state.ui.sampleHeld, false);
    assert.deepEqual(state.project.working.kick, before);
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "phrase");
    state = loop(state);
    assert.notDeepEqual(state.project.working.kick.gen1, before.gen1);
    assert.equal(state.ui.sampleLatched, true);
    state = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 118, data2: 0 });
    assert.equal(state.ui.sampleLatched, false);

    let held = session();
    const parked = clone(held.project.working.kick);
    held = reduce(held, { kind: "cc", data1: 118, data2: 127 });
    held = reduce({ ...held, tick: HOLD_TICKS }, { kind: "cc", data1: 118, data2: 0 });
    assert.equal(held.ui.sampleLatched, false);
    assert.equal(held.ui.sampleHeld, false);
    assert.deepEqual(held.project.working.kick, parked);

    const mute = reduce(reduce(session(), { kind: "cc", data1: 88, data2: 127 }), { kind: "cc", data1: 88, data2: 0 });
    assert.equal(renderScreen(mute.project, mute.ui, 0).viz, "mixer");
    assert.equal(faceButtonLed(mute.ui.face, mute.ui.faceLatch, mute.ui.faceHeld, "mixer"), PLAY_LED_ON);
    const sample = reduce(reduce(session(), { kind: "cc", data1: 118, data2: 127 }), { kind: "cc", data1: 118, data2: 0 });
    assert.equal(renderScreen(sample.project, sample.ui, 0).viz, "phrase");
  });

  it("hides the Sample row while the mixer is up", () => {
    let state = openMixer(session());
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "mixer");
    assert.notEqual(padLeds(state.project, state.ui.mode, state.ui)[24].color, 0);
    state = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 118, data2: 0 });
    assert.equal(state.ui.sampleLatched, true);
    assert.equal(state.ui.face, "mixer");
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "mixer");
    const mixPads = padLeds(state.project, state.ui.mode, state.ui);
    assert.equal(mixPads[0].color, 0);
    assert.equal(mixPads[1].color, 0);
    assert.notEqual(mixPads[24].color, 0);
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce(state, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.context, "kick");
    assert.equal(state.ui.face, null);
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "phrase");
    assert.equal(state.ui.sampleLatched, true);
    assert.equal(padLeds(state.project, state.ui.mode, state.ui)[1].color, LED.yellow);
  });

  it("restores the factory for the chosen scope and depth from the red pad", () => {
    let state = session();
    state.project.working.kick.gen1.velocity = modulated(0.7, 4, 5, 0.3);
    state.project.working.kick.sound.pitch = modulated(0.55, 9, 6, 0.4);
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    state = reduce(state, { kind: "note", data1: 68 + 12, data2: 127 });
    const during = clone(state.project.working.kick);
    assert.equal(state.project.randomizeIntensity, "medium");
    state = reduce(state, { kind: "note", data1: 68 + 7, data2: 127 });
    assert.equal(state.project.randomizeIntensity, "medium");
    assert.equal(state.project.randomizeScope, "lane");
    assert.equal(state.project.randomizeDepth, "all");
    assert.equal(state.project.working.kick.gen1.length, 16);
    assert.equal(state.project.working.kick.gen1.velocity.value, 1);
    assert.equal(state.project.working.kick.sound.pitch.value, 0.12);
    assert.equal(state.project.working.kick.sound.pitch.cycle, 1);
    assert.notDeepEqual(state.project.working.kick, during);
    const restored = clone(state.project.working.kick);
    state = loop(state);
    assert.equal(state.project.randomizeIntensity, "medium");
    assert.notDeepEqual(state.project.working.kick, restored);

    let mods = session();
    mods.project.working.kick.gen1.velocity = modulated(0.7, 4, 5, 0.3);
    mods.project.working.kick.sound.pitch = modulated(0.55, 9, 6, 0.4);
    const shape = mods.project.working.kick.gen1.length;
    mods = reduce(mods, { kind: "note", data1: 9, data2: 127 });
    mods = reduce(mods, { kind: "note", data1: 68 + 9, data2: 127 });
    mods = reduce(mods, { kind: "note", data1: 68 + 12, data2: 127 });
    mods = reduce(mods, { kind: "note", data1: 68 + 7, data2: 127 });
    assert.equal(mods.project.randomizeIntensity, "medium");
    assert.equal(mods.project.randomizeDepth, "generators");
    assert.equal(mods.project.working.kick.gen1.length, shape);
    assert.equal(mods.project.working.kick.gen1.velocity.value, 0.7);
    assert.equal(mods.project.working.kick.gen1.velocity.pattern, 0);
    assert.equal(mods.project.working.kick.gen1.velocity.cycle, 1);
    assert.equal(mods.project.working.kick.gen1.velocity.amount, 0);
    assert.equal(mods.project.working.kick.sound.pitch.value, 0.55);
    assert.equal(mods.project.working.kick.sound.pitch.pattern, 0);
    assert.equal(mods.project.working.kick.sound.pitch.cycle, 1);
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
    state = reduce(state, { kind: "cc", data1: 86, data2: 127 });
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

  it("resets every lane with Shift and Delete and asks nothing", () => {
    let state = session();
    state.project.working.kick.gen1.hits = 7;
    state.project.working.kick.sound.pitch.value = 0.9;
    state.project.working.snare.gen2.hits = 3;
    state.project.working.bass.gen1.hits = 5;
    state.project.working.lead.gen2.hits = 2;
    state.project.working.chords.gen1.hits = 4;
    state.project.working.fx.reverb.size = 0.1;
    state.project.mute.kick = true;
    state.project.lock.bass = true;
    state.project.mixer.lead = 0.2;
    state.project.progression.start = 5;
    const factory = defaultProject().working;
    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = reduce(state, { kind: "cc", data1: 119, data2: 127 });
    assert.equal(state.ui.shiftHeld, true);
    assert.equal(state.ui.deleteHeld, true);
    assert.equal(state.project.working.kick.gen1.hits, 0);
    assert.equal(state.project.working.kick.sound.pitch.value, factory.kick.sound.pitch.value);
    assert.equal(state.project.working.snare.gen2.hits, 0);
    assert.equal(state.project.working.bass.gen1.hits, 0);
    assert.equal(state.project.working.lead.gen2.hits, 0);
    assert.equal(state.project.working.chords.gen1.hits, 0);
    assert.equal(state.project.working.fx.reverb.size, factory.fx.reverb.size);
    assert.equal(state.project.mute.kick, true);
    assert.equal(state.project.lock.bass, true);
    assert.equal(state.project.mixer.lead, 0.2);
    assert.equal(state.project.progression.start, 5);
    assert.equal(generatePhrase(state.project).lanes.kick.length, 0);
    assert.equal(generatePhrase(state.project).lanes.chords.length, 0);

    state = reduce(state, { kind: "cc", data1: 49, data2: 0 });
    state = reduce(state, { kind: "cc", data1: 119, data2: 0 });
    state.project.working.hat.gen1.hits = 6;
    state.project.working.perc.gen2.hits = 2;
    state = reduce(state, { kind: "cc", data1: 119, data2: 127 });
    assert.equal(state.project.working.hat.gen1.hits, 6);
    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    assert.equal(state.project.working.hat.gen1.hits, 0);
    assert.equal(state.project.working.perc.gen2.hits, 0);
    assert.equal(state.project.journal.length, 0);

    let morph = record(defaultProject());
    morph.working.kick.gen1.hits = 8;
    morph.working.bass.pitch.value = 0.2;
    morph = launchScene(morph, morph.journal[0].id, 0);
    assert.ok(morph.morph);
    morph.working.kick.gen1.hits = 3;
    morph.working.bass.pitch.value = 0.8;
    morph.working.chords.gen1.hits = 2;
    state = { project: morph, ui: { ...defaultUi(), shiftHeld: true }, tick: 0, playing: false };
    state = reduce(state, { kind: "cc", data1: 119, data2: 127 });
    const stuck = applyMorph(state.project, (state.project.morph?.originTick ?? 0) + 1);
    assert.equal(stuck.working.kick.gen1.hits, 0);
    assert.equal(stuck.working.bass.pitch.value, factory.bass.pitch.value);
    assert.equal(stuck.working.chords.gen1.hits, 0);
  });

  it("locks from the mixer page and switches journal and set from the menu button", () => {
    let state = openMixer(session());
    const leds = padLeds(state.project, "journal", state.ui);
    assert.equal(leds[24].color, LED.red);
    assert.equal(leds[24].blink, false);
    assert.equal(leds[25].blink, false);
    assert.equal(leds[31].color, 9);
    assert.equal(leds[23].color, 0);
    assert.equal(leds[0].color, 0);
    state = reduce(state, { kind: "note", data1: 99, data2: 127 });
    assert.equal(state.project.mute.fx, true);
    state = reduce(state, { kind: "note", data1: 83, data2: 127 });
    assert.equal(state.project.lock.fx, true);
    state = reduce(state, { kind: "note", data1: 99, data2: 127 });
    state = reduce(state, { kind: "note", data1: 83, data2: 127 });
    assert.equal(state.project.mute.fx, false);
    assert.equal(state.project.lock.fx, false);
    state.project.mute.snare = true;
    assert.equal(padLeds(state.project, "journal", state.ui)[25].color, LED.off);
    state = reduce(state, { kind: "note", data1: 77, data2: 127 });
    assert.equal(state.project.lock.snare, true);
    assert.equal(padLeds(state.project, "journal", state.ui)[9].color, LED.lock);
    assert.equal(state.ui.context, "kick");
    state = reduce(state, { kind: "note", data1: 85, data2: 127 });
    assert.equal(state.project.mute.snare, true);
    assert.equal(state.project.mute.kick, false);
    assert.equal(state.project.solo.snare, true);
    assert.equal(padLeds(state.project, "journal", state.ui)[25].color, LED.off);
    assert.equal(padLeds(state.project, "journal", state.ui)[17].color, LED.red);
    assert.equal(padLeds(state.project, "journal", state.ui)[16].color, LED.off);
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
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce(state, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.context, "kick");
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

function vizLit(screen: Screen): number {
  let count = 0;
  for (let y = HEADER_H; y < HEADER_H + VIZ_H - 1; y++) {
    for (let x = 0; x < WIDTH; x++) if (pixel(screen, x, y)) count++;
  }
  return count;
}

function pixelsMoved(a: Screen, b: Screen): number {
  let count = 0;
  for (let i = 0; i < a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) count++;
  return count;
}

function grooveTape(): WaveTape {
  const tape = emptyWave();
  const beat = Math.floor(22050 / WAVE_HOP) * WAVE_HOP;
  for (let hop = 0; hop < 8; hop++) {
    tape.left.set(hop * WAVE_HOP, 1);
    tape.right.set(hop * WAVE_HOP, 0.35);
    tape.left.set(beat + hop * WAVE_HOP, 0.4);
    tape.right.set(beat + hop * WAVE_HOP, 1);
  }
  return tape;
}

function paintDeck(project: ReturnType<typeof session>["project"], ui: ReturnType<typeof session>["ui"], tick: number, tape: WaveTape = grooveTape()): Screen {
  return renderScreen(project, ui, tick, true, ui.pageTitleUntilMs ?? Date.now(), undefined, undefined, tape);
}

function tallGap(screen: Screen): number {
  const yBottom = HEADER_H + VIZ_H - 2;
  const mid = HEADER_H + Math.floor((yBottom - HEADER_H) / 2);
  const cols: number[] = [];
  for (let x = 0; x < WIDTH; x++) {
    if (x === WIDTH / 2) continue;
    let n = 0;
    for (let y = HEADER_H; y < mid; y++) if (pixel(screen, x, y)) n++;
    if (n >= 6) cols.push(x);
  }
  const groups: number[][] = [];
  for (const x of cols) {
    const last = groups[groups.length - 1];
    if (!last || x - last[last.length - 1] > 8) groups.push([x]);
    else last.push(x);
  }
  if (groups.length < 2) return -1;
  const mean = (group: number[]) => group.reduce((sum, x) => sum + x, 0) / group.length;
  return mean(groups[1]) - mean(groups[0]);
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
    const need = Math.ceil(knobClicksPerStep(cycle) - 1e-9);
    const caught = stepKnob(3, cycle, need, null);
    assert.equal(caught.value, 4);
    assert.equal(caught.hold?.left, DETENT_CLICKS);
    let hold: DetentHold | null = caught.hold;
    for (let i = 0; i < DETENT_CLICKS; i++) {
      const stuck = stepKnob(4, cycle, 1, hold);
      assert.equal(stuck.value, 4);
      hold = stuck.hold;
    }
    let left = stepKnob(4, cycle, 1, hold, 0, 0);
    let guard = 0;
    while (left.value === 4 && guard++ < 5) left = stepKnob(left.value, cycle, 1, left.hold, 0, left.pending);
    assert.equal(left.value, 5);
    assert.equal(left.hold, null);
    assert.equal(stepKnob(3, cycle, 7, null).value, 4);
    assert.equal(stepKnob(4, cycle, 7, null).value, 4);
    const span = Math.ceil(4 * knobClicksPerStep(cycle) - 1e-9);
    assert.equal(stepKnob(4, cycle, DETENT_CLICKS + span, null).value, 8);
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
    let hold: DetentHold | null = onto.hold;
    for (let i = 0; i < DETENT_CLICKS; i++) {
      const stuck = stepKnob(0, amount, -1, hold);
      assert.equal(stuck.value, 0);
      hold = stuck.hold;
    }
    const off = stepKnob(0, amount, -1, hold);
    assert.ok(Math.abs(off.value + 0.01) < 1e-9);

    const cutoff = knob("filter.cutoff.value");
    assert.deepEqual(cutoff.detents, [0.5]);
    const open = stepKnob(0.49, cutoff, Math.ceil(knobClicksPerStep(cutoff) - 1e-9), null);
    assert.equal(open.value, 0.5);
    const stay = stepKnob(open.value, cutoff, 1, open.hold);
    assert.equal(stay.value, 0.5);
    let cut = open.hold;
    for (let i = 0; i < DETENT_CLICKS; i++) cut = stepKnob(0.5, cutoff, 1, cut).hold;
    let past = stepKnob(0.5, cutoff, 1, cut, 0, 0);
    let moved = 0;
    while (Math.abs(past.value - 0.5) < 1e-9 && moved++ < 5) past = stepKnob(past.value, cutoff, 1, past.hold, 0, past.pending);
    assert.ok(Math.abs(past.value - 0.51) < 1e-6);

    assert.deepEqual(knob("pitch.value").detents, [0.5]);
    assert.deepEqual(knob("sound.pos.value").detents, [0.5]);
    assert.equal(knob("sound.pos.value").label, "POS V");
    assert.deepEqual(knob("macro.probability").detents, [0]);
    assert.deepEqual(knob("transpose").detents, [0]);
    assert.deepEqual(knob("start").detents, [0]);

    assert.deepEqual(knob("gen1.length").detents, [1, 2, 4, 8, 16, 32, 64]);
    assert.deepEqual(knob("gen2.length").detents, [1, 2, 4, 8, 16, 32, 64]);

    const hits = knob("gen1.hits");
    assert.equal(hits.detents, undefined);
    const still = stepKnob(16, hits, 1, null);
    assert.equal(still.value, 16);
    let stepped = still;
    let guard = 0;
    while (stepped.value === 16 && guard++ < 5) stepped = stepKnob(stepped.value, hits, 1, stepped.hold, 0, stepped.pending);
    assert.equal(stepped.value, 17);
    assert.equal(stepped.hold, null);
  });

  it("leaves a rested detent on the next movement", () => {
    const cycle = knob("gen1.velocity.cycle");
    const caught = stepKnob(3, cycle, Math.ceil(knobClicksPerStep(cycle) - 1e-9), null, 0);
    assert.equal(caught.value, 4);
    const soon = stepKnob(4, cycle, 1, caught.hold, DETENT_REST_MS);
    assert.equal(soon.value, 4);
    assert.equal(soon.hold?.left, DETENT_CLICKS - 1);
    const rested = stepKnob(4, cycle, 1, caught.hold, DETENT_REST_MS + 1);
    assert.equal(rested.value, 4);
    assert.equal(rested.hold?.left, 0);
    let moved = rested;
    let guard = 0;
    while (moved.value === 4 && guard++ < 5) moved = stepKnob(moved.value, cycle, 1, moved.hold, DETENT_REST_MS + 1, moved.pending);
    assert.equal(moved.value, 5);
    assert.equal(moved.hold, null);
    const flick = stepKnob(4, cycle, Math.ceil(4 * knobClicksPerStep(cycle) - 1e-9), caught.hold, DETENT_REST_MS + 1);
    assert.equal(flick.value, 8);
  });
});

describe("knob sensitivity", () => {
  function knob(path: string) {
    const found = bindingFor(path);
    assert.ok(found);
    return found;
  }

  function sweepClicks(path: string, from: number, to: number): number {
    const binding = knob(path);
    let value = from;
    let hold: DetentHold | null = null;
    let pending = 0;
    let clicks = 0;
    const dir = to >= from ? 1 : -1;
    while ((dir > 0 ? value < to - 1e-9 : value > to + 1e-9) && clicks < 5000) {
      const stepped = stepKnob(value, binding, dir, hold, 0, pending);
      value = stepped.value;
      hold = stepped.hold;
      pending = stepped.pending;
      clicks++;
    }
    return clicks;
  }

  it("fits a hundred steps and one interior detent into about 220 degrees", () => {
    const cutoff = knob("filter.cutoff.value");
    assert.deepEqual(cutoff.detents, [0.5]);
    const clicks = sweepClicks("filter.cutoff.value", 0, 1);
    const degrees = clicks * (360 / ENCODER_CLICKS_PER_TURN);
    assert.ok(Math.abs(degrees - KNOB_SWEEP_DEG) < 4, `sweep was ${degrees}`);
  });

  it("keeps a sparse step inside 20 degrees and a shorter total travel", () => {
    const quant = knob("deck.quant");
    const per = knobClicksPerStep(quant);
    assert.ok(per * (360 / ENCODER_CLICKS_PER_TURN) <= KNOB_MAX_STEP_DEG + 1e-9);
    const clicks = sweepClicks("deck.quant", quant.min, quant.max);
    const degrees = clicks * (360 / ENCODER_CLICKS_PER_TURN);
    assert.ok(degrees < KNOB_SWEEP_DEG - 1);
    const slack = (360 / ENCODER_CLICKS_PER_TURN) * (quant.max - quant.min);
    assert.ok(degrees <= (quant.max - quant.min) * KNOB_MAX_STEP_DEG + slack);
  });

  it("slows tempo to a quarter and transpose to a half", () => {
    const tempo = knob("tempo");
    const transpose = knob("transpose");
    assert.equal(tempo.sensitivity, 0.25);
    assert.equal(transpose.sensitivity, 0.5);
    const tempoSteps = (tempo.max - tempo.min) / tempo.step;
    const tempoDegrees = knobClicksPerStep(tempo) * (360 / ENCODER_CLICKS_PER_TURN) * tempoSteps;
    assert.ok(Math.abs(tempoDegrees - KNOB_SWEEP_DEG * 4) < 1, `tempo sweep was ${tempoDegrees}`);
    const transposeSteps = (transpose.max - transpose.min) / transpose.step;
    const transposeDegrees = knobClicksPerStep(transpose) * (360 / ENCODER_CLICKS_PER_TURN) * transposeSteps;
    assert.ok(transposeDegrees > KNOB_SWEEP_DEG * 1.8);
    assert.ok(transposeDegrees < KNOB_SWEEP_DEG * 2.2);
  });

  it("turns the pattern knob at quarter sensitivity", () => {
    const pattern = knob("gen1.velocity.pattern");
    const hits = knob("gen1.hits");
    assert.equal(pattern.sensitivity, 0.25);
    assert.equal(hits.sensitivity, 1);
    const steps = (pattern.max - pattern.min) / pattern.step;
    const degrees = knobClicksPerStep(pattern) * (360 / ENCODER_CLICKS_PER_TURN) * steps;
    assert.ok(degrees > KNOB_SWEEP_DEG * 3.6);
    assert.ok(degrees < KNOB_SWEEP_DEG * 4.4);
  });

  it("keeps a partial turn until the knob or the page changes", () => {
    const hits = knob("gen1.hits");
    const first = stepKnob(16, hits, 1, null);
    assert.equal(first.value, 16);
    assert.ok(first.pending > 0);
    const back = stepKnob(first.value, hits, -1, first.hold, 0, first.pending);
    assert.equal(back.value, 16);
    assert.ok(Math.abs(back.pending) < first.pending);
    let second = first;
    let guard = 0;
    while (second.value === 16 && guard++ < 5) second = stepKnob(second.value, hits, 1, second.hold, 0, second.pending);
    assert.equal(second.value, 17);

    let state = session();
    const before = state.project.working.kick.gen1.hits;
    state = reduce(state, { kind: "cc", data1: 72, data2: 1 });
    assert.equal(state.project.working.kick.gen1.hits, before);
    assert.equal(state.ui.travel?.path, "gen1.hits");
    state = reduce(state, { kind: "note", data1: 0, data2: 127 });
    assert.equal(state.ui.travel, null);
    state = reduce(state, { kind: "cc", data1: 72, data2: 1 });
    assert.equal(state.ui.travel?.path, "gen1.hits");
    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    assert.equal(state.ui.travel, null);
  });
});

describe("mixer and deck buttons", () => {
  it("latches on a short press and returns on a long release", () => {
    let state = session();
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    state = reduce(state, { kind: "note", data1: 20, data2: 0 });
    const down = reduce(state, { kind: "cc", data1: 88, data2: 127 });
    assert.equal(down.ui.face, "mixer");
    assert.equal(down.ui.faceHeld, "mixer");
    assert.equal(faceButtonLed(down.ui.face, down.ui.faceLatch, down.ui.faceHeld, "mixer"), PLAY_LED_ON);
    assert.equal(renderScreen(down.project, down.ui, 0).viz, "mixer");
    const back = reduce({ ...down, tick: HOLD_TICKS }, { kind: "cc", data1: 88, data2: 0 });
    assert.equal(back.ui.face, null);
    assert.equal(back.ui.context, "bass");
    assert.equal(renderScreen(back.project, back.ui, 0).viz, "phrase");
    assert.equal(faceButtonLed(back.ui.face, back.ui.faceLatch, back.ui.faceHeld, "mixer"), 0);

    state = openMixer(state);
    assert.equal(state.ui.faceLatch, "mixer");
    assert.equal(state.ui.context, "bass");
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "mixer");
    const peek = reduce(state, { kind: "cc", data1: 52, data2: 127 });
    assert.equal(peek.ui.face, "deck");
    assert.equal(peek.ui.faceLatch, "mixer");
    assert.equal(faceButtonLed(peek.ui.face, peek.ui.faceLatch, peek.ui.faceHeld, "deck"), PLAY_LED_ON);
    assert.equal(faceButtonLed(peek.ui.face, peek.ui.faceLatch, peek.ui.faceHeld, "mixer"), PLAY_LED_ON);
    assert.equal(renderScreen(peek.project, peek.ui, 0).viz, "deck");
    const returned = reduce({ ...peek, tick: peek.tick + HOLD_TICKS }, { kind: "cc", data1: 52, data2: 0 });
    assert.equal(returned.ui.face, "mixer");
    assert.equal(returned.ui.faceLatch, "mixer");
    assert.equal(returned.ui.context, "bass");
    assert.equal(renderScreen(returned.project, returned.ui, 0).viz, "mixer");

    state = openDeck(returned);
    assert.equal(state.ui.face, "deck");
    assert.equal(state.ui.faceLatch, "deck");
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "deck");
    state = tapCc(state, 52);
    assert.equal(state.ui.face, null);
    assert.equal(state.ui.context, "bass");
    assert.equal(renderScreen(state.project, state.ui, 0).viz, "phrase");
  });
});

describe("deck screen", () => {
  it("opens from Capture and leaves Sample on the phrase", () => {
    assert.equal(pageCount("aux"), 4);
    assert.equal(pagesFor("aux")[3]?.title, "BUS");
    const before = session();
    const tapped = reduce(reduce(before, { kind: "cc", data1: 118, data2: 127 }), { kind: "cc", data1: 118, data2: 0 });
    assert.equal(tapped.ui.context, "kick");
    assert.equal(tapped.ui.face, null);
    assert.equal(renderScreen(tapped.project, tapped.ui, 0).viz, "phrase");
    const open = openDeck(before);
    assert.equal(open.ui.context, "kick");
    assert.equal(open.ui.page, 0);
    assert.equal(open.ui.face, "deck");
    assert.equal(open.project.journal.length, 0);
    assert.equal(open.project.nextSceneId, before.project.nextSceneId);
    const screen = renderScreen(open.project, open.ui, 0);
    assert.equal(screen.viz, "deck");
    assert.equal(screen.header, "BEAT REPEAT");
    assert.equal(screen.labels.some((label) => label.y === TITLE_Y && label.text === "DJ"), true);
    assert.equal(screen.labels.some((label) => label.text === "TIME" || label.text === "DECK"), false);
    const quantKnob = bindingFor("deck.quant");
    assert.ok(quantKnob);
    const quant = reduce(open, { kind: "cc", data1: 77, data2: Math.ceil(knobClicksPerStep(quantKnob)) });
    assert.equal(renderScreen(quant.project, quant.ui, 0).header, "quantize: bar");
    assert.equal(screen.labels.some((label) => label.text === "ROL"), false);
    assert.equal(screen.labels.some((label) => label.y >= HEADER_H && label.y < SEP_Y), false);
    assert.equal(screen.labels.some((label) => label.text === "1/8" || label.text === "/16" || label.text === "/32"), false);
    assert.deepEqual(screen.digits.find((digit) => digit.cell === 5)?.amount, { kind: "big", n: 8, negative: false });
    assert.equal(screen.labels.some((label) => label.text === "BEA"), true);
    const tim = renderScreen({ ...open.project, deck: { ...open.project.deck, focus: 6 } }, open.ui, 0);
    assert.deepEqual(tim.digits.find((digit) => digit.cell === 5)?.amount, { kind: "big", n: 1, negative: false });
    const opn = renderScreen({ ...open.project, deck: { ...open.project.deck, focus: 7 } }, open.ui, 0);
    assert.deepEqual(opn.digits.find((digit) => digit.cell === 5)?.amount, { kind: "big", n: 4, negative: false });
    const two = renderScreen({ ...open.project, deck: { ...open.project.deck, focus: 6, brake: 5 } }, open.ui, 0);
    assert.deepEqual(
      [two.labels.find((label) => label.cell === 5 && label.y === DIGIT_Y)?.text, two.labels.find((label) => label.cell === 5 && label.y === DIGIT_Y + FONT_H + 1)?.text],
      ["2", "1"],
    );
    const pitch = {
      ...open.project,
      deck: {
        ...open.project.deck,
        focus: 5,
        cells: open.project.deck.cells.map((cell, index) => (index === 5 ? { ...cell, x: 0 } : cell)),
      },
    };
    const speed = renderScreen(pitch, open.ui, 0);
    assert.equal(speed.labels.some((label) => label.text === "1/2" && label.cell === 5), true);
    assert.equal(speed.digits.some((digit) => digit.cell === 5), false);
    assert.ok(vizLit(screen) > 40);
  });

  it("takes every pad for a gesture and does not launch a scene", () => {
    let state = session();
    state = { ...state, project: record(record(state.project)) };
    const first = state.project.journal[0]?.id;
    const second = state.project.journal[1]?.id;
    state = { ...state, project: launchScene(state.project, first ?? "", 0) };
    assert.equal(state.project.morph?.targetId, first);
    state = openDeck(state);
    const top = reduce(state, { kind: "note", data1: 92, data2: 127 });
    assert.equal(top.ui.deckGesture, "rpt");
    assert.equal(top.ui.deckGestureTick, top.tick);
    assert.equal(top.project.morph?.targetId, first);
    assert.equal(renderScreen(top.project, top.ui, 0).header, "BEAT REPEAT");
    const idle = padLeds(top.project, "journal", { face: top.ui.face, context: top.ui.context, page: top.ui.page });
    const lit = padLeds(top.project, "journal", top.ui);
    assert.equal(lit[24]?.color, 3);
    assert.equal(lit[16]?.color, offColor(9));
    assert.equal(lit[4]?.color, 3);
    assert.equal(lit[4]?.blink, false);
    assert.equal(idle[4]?.color, 3);
    assert.equal(idle[4]?.blink, false);
    assert.equal(idle[24]?.color, 3);
    const up = reduce(top, { kind: "note", data1: 92, data2: 0 });
    assert.equal(up.ui.deckGesture, null);
    assert.equal(up.ui.deckGestureTick, null);
    const bottom = reduce(up, { kind: "note", data1: 69, data2: 127 });
    assert.equal(bottom.ui.deckGesture, "thr");
    assert.equal(bottom.project.morph?.targetId, first);
    assert.notEqual(bottom.project.morph?.targetId, second);
    const divKnob = bindingFor("deck.div");
    assert.ok(divKnob);
    const turned = reduce(openDeck(session()), { kind: "cc", data1: 76, data2: Math.ceil(knobClicksPerStep(divKnob)) });
    assert.equal(turned.project.deck.div, 3);
  });

  it("shows the selected group's knobs and parks depth on the right", () => {
    const open = openDeck(session());
    const idle = renderScreen(open.project, open.ui, 0);
    assert.deepEqual(idle.dim, []);
    const names = (state: Session) =>
      renderScreen(state.project, state.ui, 0).labels.filter((label) => label.y === NAME_Y).map((label) => label.text);
    const namedCell = (state: Session, text: string) =>
      renderScreen(state.project, state.ui, 0).labels.find((label) => label.y === NAME_Y && label.text === text)?.cell;
    assert.deepEqual(names(open), ["WAY", "DIV", "QNT", "DEP"]);
    assert.equal(namedCell(open, "DIV"), 5);
    assert.equal(namedCell(open, "QNT"), 6);
    assert.equal(namedCell(open, "DEP"), 7);
    const corner = reduce(open, { kind: "note", data1: 99, data2: 127 });
    assert.equal(corner.project.deck.div, 5);
    assert.equal(corner.project.deck.cells[0]?.y, 3);
    const cornerScreen = renderScreen(corner.project, corner.ui, 0);
    assert.deepEqual(cornerScreen.digits.find((digit) => digit.cell === 5)?.amount, { kind: "big", n: 1, negative: false });
    assert.equal(cornerScreen.labels.some((label) => label.text === "1/1"), false);
    assert.equal(cornerScreen.labels.some((label) => label.text === "PNG"), true);
    assert.equal(namedCell(corner, "QNT"), 6);
    assert.equal(namedCell(corner, "DEP"), 7);
    const scratch = reduce(open, { kind: "note", data1: 68, data2: 127 });
    assert.deepEqual(names(scratch), ["CMP", "CUE", "THR", "CUT", "DIR", "DUR", "QNT", "DEP"]);
    assert.equal(namedCell(scratch, "DUR"), 5);
    const scratchScreen = renderScreen(scratch.project, scratch.ui, 0);
    assert.equal(scratchScreen.labels.some((label) => label.text === "SGL" && label.cell === 0), true);
    assert.equal(scratchScreen.labels.some((label) => label.text === "1/4" && label.cell === 5), true);
    assert.equal(scratchScreen.digits.some((digit) => digit.cell === 1 && digit.amount.kind === "big" && digit.amount.n === 0), true);
    assert.equal(namedCell(scratch, "QNT"), 6);
    assert.equal(namedCell(scratch, "DEP"), 7);
    assert.deepEqual(renderScreen(scratch.project, scratch.ui, 0).dim, []);
    const pitch = reduce(open, { kind: "note", data1: 85, data2: 127 });
    assert.deepEqual(names(pitch), ["SHP", "BND", "RTE", "QNT", "DEP"]);
    assert.equal(namedCell(pitch, "RTE"), 5);
    assert.equal(pitch.project.deck.div, 2);
    const slow = reduce(pitch, { kind: "note", data1: 78, data2: 127 });
    assert.equal(slow.project.deck.cells[5]?.x, 0);
    assert.equal(slow.project.deck.cells[5]?.y, 1);
    assert.equal(slow.project.deck.div, 2);
    const slowScreen = renderScreen(slow.project, slow.ui, 0);
    assert.equal(slowScreen.labels.some((label) => label.text === "1/2"), true);
    assert.equal(slowScreen.labels.some((label) => label.text === "RIS"), true);
    const loop = reduce(open, { kind: "note", data1: 84, data2: 127 });
    const loopScreen = renderScreen(loop.project, loop.ui, 0);
    assert.deepEqual(loopScreen.digits.find((digit) => digit.cell === 5)?.amount, { kind: "big", n: 8, negative: false });
    assert.equal(loopScreen.labels.some((label) => label.text.includes("/16")), false);
    const held = renderScreen(loop.project, {
      ...loop.ui,
      focus: { label: "LEN", path: "deck.len", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 },
    }, 0);
    assert.equal(held.header, "length: 1/2");
    const eighth = renderScreen(
      { ...loop.project, deck: { ...loop.project.deck, len: 1 / 16 } },
      { ...loop.ui, focus: { label: "LEN", path: "deck.len", generator: null, showPattern: false, held: true, untilTick: 0, untilMs: 0 } },
      0,
    );
    assert.equal(eighth.header, "length: 1/8");
    assert.deepEqual(eighth.digits.find((digit) => digit.cell === 5)?.amount, { kind: "big", n: 2, negative: false });
    assert.equal(namedCell(slow, "QNT"), 6);
    assert.equal(namedCell(slow, "DEP"), 7);
    const field = padLeds(scratch.project, "journal", scratch.ui);
    assert.equal(field[31]?.color, offColor(1));
    assert.equal(field[2]?.color, offColor(1));
    assert.equal(field[3]?.color, 1);
    assert.equal(field[6]?.color, offColor(1));
    assert.equal(field[24]?.color, offColor(3));
  });

  it("walks the recorded master under a fixed stylus", () => {
    const roll = reduce(openDeck(session()), { kind: "note", data1: 92, data2: 127 });
    const tape = grooveTape();
    const start = paintDeck(roll.project, roll.ui, 0, tape);
    const mid = paintDeck(roll.project, roll.ui, 48, tape);
    const again = paintDeck(roll.project, roll.ui, 96, tape);
    assert.ok(pixelsMoved(start, mid) > 10);
    assert.equal(pixelsMoved(start, again), 0);
    assert.equal(start.header, "BEAT REPEAT");
  });

  it("draws the master in stereo from the center and keeps the bar scale under a pad", () => {
    const open = openDeck(session());
    const tape = grooveTape();
    const idle = paintDeck(open.project, open.ui, 0, tape);
    const roll = reduce(open, { kind: "note", data1: 92, data2: 127 });
    const held = paintDeck(roll.project, roll.ui, 0, tape);
    const yBottom = HEADER_H + VIZ_H - 2;
    const h = yBottom - HEADER_H + 1;
    const mid = HEADER_H + Math.floor((h - 1) / 2);
    let above = 0;
    let below = 0;
    let differ = 0;
    for (let x = 0; x < WIDTH; x++) {
      for (let y = HEADER_H; y < mid; y++) if (pixel(idle, x, y)) above++;
      for (let y = mid + 1; y <= yBottom; y++) if (pixel(idle, x, y)) below++;
      for (let d = 1; d <= 12; d++) if (mid - d >= HEADER_H && mid + d <= yBottom && pixel(idle, x, mid - d) !== pixel(idle, x, mid + d)) differ++;
    }
    assert.ok(above > 20);
    assert.ok(below > 20);
    assert.ok(differ > 10);
    assert.ok(Math.abs(tallGap(idle) - 32) <= 2);
    assert.ok(Math.abs(tallGap(held) - 32) <= 2);
    const later = paintDeck(open.project, open.ui, 48, tape);
    const cursor = WIDTH / 2;
    assert.equal(pixel(later, cursor, mid), 0);
    assert.equal(pixel(later, cursor - 1, mid), 1);
    assert.ok(pixelsMoved(idle, later) > 10);
  });

  it("keeps pad pressure on the second row from opening the mixer", () => {
    const pressure = midiMessage(0xa0, 88, 40);
    assert.equal(pressure, null);
    assert.equal(midiMessage(0xa0, 86, 20), null);
    assert.equal(midiMessage(0xa0, 85, 20), null);
    const note = midiMessage(0x90, 88, 127);
    assert.deepEqual(note, { kind: "note", data1: 88, data2: 127 });
    const mute = midiMessage(0xb0, 88, 127);
    assert.deepEqual(mute, { kind: "cc", data1: 88, data2: 127 });
    const open = openDeck(session());
    const pad = reduce(open, note ?? { kind: "note", data1: 88, data2: 127 });
    assert.equal(pad.ui.deckGesture, "rpt");
    const mixed = reduce(session(), mute ?? { kind: "cc", data1: 88, data2: 127 });
    assert.equal(renderScreen(mixed.project, mixed.ui, 0).viz, "mixer");
    assert.equal(faceButtonLed(mixed.ui.face, mixed.ui.faceLatch, mixed.ui.faceHeld, "mixer"), PLAY_LED_ON);
  });

  it("latches a gesture with shift, and Sample leaves the deck pads alone", () => {
    let state = openDeck(session());
    state = reduce(state, { kind: "cc", data1: 49, data2: 127 });
    state = reduce(state, { kind: "note", data1: 92, data2: 127 });
    state = reduce(state, { kind: "note", data1: 92, data2: 0 });
    state = reduce(state, { kind: "cc", data1: 49, data2: 0 });
    assert.equal(state.ui.deckLatchedGesture, "rpt");
    assert.equal(state.ui.deckLatchTick, state.tick);
    assert.equal(state.ui.deckGesture, null);
    assert.equal(state.ui.deckGestureTick, null);
    const again = reduce(reduce(state, { kind: "cc", data1: 49, data2: 127 }), { kind: "note", data1: 92, data2: 127 });
    assert.equal(again.ui.deckLatchedGesture, null);
    assert.equal(again.ui.deckLatchTick, null);
    const captured = reduce(state, { kind: "cc", data1: 118, data2: 127 });
    const pad = reduce(captured, { kind: "note", data1: 92, data2: 127 });
    assert.equal(pad.ui.sampleHeld, true);
    assert.equal(pad.ui.deckGesture, "rpt");
    assert.equal(pad.ui.deckLatchedGesture, "rpt");
    assert.equal(pad.project.transition, state.project.transition);
    const wheeled = reduce({ ...state, ui: { ...state.ui, wheelTouch: true } }, { kind: "note", data1: 69, data2: 127 });
    assert.equal(wheeled.ui.deckGesture, "thr");
    assert.equal(wheeled.ui.deckLatchedGesture, "rpt");
    assert.equal(wheeled.project.randomizeDepth, "all");
    assert.equal(wheeled.ui.page, 0);
    assert.equal(wheeled.ui.face, "deck");
    const left = reduce(reduce(state, { kind: "note", data1: 16, data2: 127 }), { kind: "note", data1: 16, data2: 0 });
    assert.equal(left.ui.context, "kick");
    assert.equal(left.ui.deckLatchedGesture, null);
    assert.equal(left.ui.deckGesture, null);
  });
});

describe("page title", () => {
  function titleLeft(text: string): number {
    return Math.floor((WIDTH - lettersWidth(text)) / 2);
  }

  it("prints the page title over the phrase while the jog is touched and drops it on release", () => {
    let ysMin = DIGIT_H;
    let ysMax = 0;
    plotLetters("GENERATOR 1", 0, 0, (_x, y) => {
      ysMin = Math.min(ysMin, y);
      ysMax = Math.max(ysMax, y);
    });
    assert.equal(ysMax - ysMin + 1, DIGIT_H);
    assert.equal(CAPTION_LANE_Y, HEADER_H + CAPTION_GAP);
    assert.equal(CAPTION_PAGE_Y, CAPTION_LANE_Y + DIGIT_H + CAPTION_GAP);
    assert.equal(SEP_Y - 2 - (CAPTION_PAGE_Y + DIGIT_H - 1), CAPTION_GAP);
    assert.equal(CAPTION_SINGLE_Y - HEADER_H, SEP_Y - 2 - (CAPTION_SINGLE_Y + DIGIT_H - 1));
    assert.ok(CAPTION_PAGE_Y + DIGIT_H + CAPTION_OUTLINE < SEP_Y);
    assert.ok(SEP_Y < DIGIT_Y);

    let state = session();
    placeHits(state.project);
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    assert.equal(state.ui.pageTitleSlide, null);
    const until = state.ui.pageTitleUntilMs ?? 0;
    assert.ok(until - Date.now() <= PAGE_TITLE_MS && until - Date.now() > PAGE_TITLE_MS - 1000);
    const shown = renderScreen(state.project, state.ui, 0, false, until - 1);
    const bare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null }, 0, false, until - 1);
    assertOutline(shown, bare, [captionAt("BEAT GEN")]);
    for (let y = DIGIT_Y; y < DIGIT_Y + DIGIT_H; y++) {
      for (let x = 0; x < WIDTH; x++) assert.equal(pixel(shown, x, y), 0);
    }
    const held = renderScreen(state.project, state.ui, 0, false, until);
    const heldBare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null }, 0, false, until);
    assertOutline(held, heldBare, [captionAt("BEAT GEN")]);

    const released = reduce(state, { kind: "note", data1: 9, data2: 0 });
    assert.equal(released.ui.pageTitleUntilMs, null);
    assert.equal(released.ui.wheelTouch, true);
    const gone = renderScreen(released.project, released.ui, 0, false, until - 1);
    const goneBare = renderScreen(released.project, { ...released.ui, pageTitleUntilMs: null }, 0, false, until - 1);
    assert.deepEqual(gone.pixels, goneBare.pixels);
    const settled = settleWheel(released.ui, (released.ui.wheelReleaseMs ?? 0) + WHEEL_RELEASE_MS);
    assert.equal(settled.wheelTouch, false);
  });

  it("slides the title when the jog changes page and snaps when a pad does", () => {
    let state = session();
    placeHits(state.project);
    state = reduce(state, { kind: "note", data1: 9, data2: 127 });
    const touchedUntil = state.ui.pageTitleUntilMs ?? 0;
    const stuck = reduce(state, { kind: "cc", data1: 14, data2: 127 });
    assert.equal(stuck.ui.page, 0);
    assert.equal(stuck.ui.pageTitleUntilMs, touchedUntil);
    assert.equal(stuck.ui.pageTitleSlide, null);

    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    assert.equal(state.ui.page, 1);
    assert.ok((state.ui.pageTitleUntilMs ?? 0) >= touchedUntil);
    assert.equal(state.ui.pageTitleSlide?.from, "BEAT GEN");
    assert.equal(state.ui.pageTitleSlide?.dir, 1);
    const started = state.ui.pageTitleSlide?.startedMs ?? 0;
    const travel = pageTitleTravel(PAGE_TITLE_SLIDE_MS / 2);
    const fromX = titleLeft("BEAT GEN") - travel;
    const toX = titleLeft("ROLL GEN") + (WIDTH - travel);
    assert.ok(toX > titleLeft("ROLL GEN"));
    const at = started + PAGE_TITLE_SLIDE_MS / 2;
    const mid = renderScreen(state.project, state.ui, 0, false, at);
    const midBare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null }, 0, false, at);
    assertOutline(mid, midBare, [
      { text: "BEAT GEN", x: fromX, y: CAPTION_SINGLE_Y },
      { text: "ROLL GEN", x: toX, y: CAPTION_SINGLE_Y },
    ]);
    const settledAt = started + PAGE_TITLE_SLIDE_MS;
    const settled = renderScreen(state.project, state.ui, 0, false, settledAt);
    const settledBare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null }, 0, false, settledAt);
    assertOutline(settled, settledBare, [captionAt("ROLL GEN")]);

    const until = state.ui.pageTitleUntilMs ?? 0;
    state = reduce(state, { kind: "note", data1: 94, data2: 127 });
    assert.equal(state.ui.page, 2);
    assert.equal(state.ui.pageTitleSlide, null);
    assert.ok((state.ui.pageTitleUntilMs ?? 0) >= until);
    const next = pagesFor("kick")[2]?.title ?? "";
    const snappedAt = (state.ui.pageTitleUntilMs ?? 0) - 1;
    const snapped = renderScreen(state.project, state.ui, 0, false, snappedAt);
    const snappedBare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null }, 0, false, snappedAt);
    assertOutline(snapped, snappedBare, [captionAt(next)]);
  });

  it("outlines a button page title and writes the lane above it when the lane changes", () => {
    const paint = (state: ReturnType<typeof session>) => {
      const until = (state.ui.pageTitleUntilMs ?? 0) - 1;
      const shown = renderScreen(state.project, state.ui, 0, false, until);
      const bare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null }, 0, false, until);
      return { shown, bare };
    };

    let state = session();
    placeHits(state.project);
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    assert.equal(state.ui.heldContext, "bass");
    assert.equal(state.ui.pageTitleSlide, null);
    assert.equal(state.ui.pageTitleLane, true);
    const bass = pagesFor("bass")[0]?.title ?? "";
    let frame = paint(state);
    assertOutline(frame.shown, frame.bare, [captionAt("BASS", CAPTION_LANE_Y), captionAt(bass, CAPTION_PAGE_Y)]);
    const heldPast = (state.ui.pageTitleUntilMs ?? 0) + PAGE_TITLE_MS;
    const stillHeld = renderScreen(state.project, state.ui, 0, false, heldPast);
    const stillHeldBare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null }, 0, false, heldPast);
    assertOutline(stillHeld, stillHeldBare, [captionAt("BASS", CAPTION_LANE_Y), captionAt(bass, CAPTION_PAGE_Y)]);

    state = reduce(state, { kind: "note", data1: 93, data2: 127 });
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.pageTitleSlide, null);
    assert.equal(state.ui.pageTitleLane, true);
    const page = pagesFor("bass")[1]?.title ?? "";
    frame = paint(state);
    assertOutline(frame.shown, frame.bare, [captionAt("BASS", CAPTION_LANE_Y), captionAt(page, CAPTION_PAGE_Y)]);

    state = reduce(state, { kind: "note", data1: 20, data2: 0 });
    assert.equal(state.ui.context, "bass");
    assert.equal(state.ui.page, 1);
    assert.equal(state.ui.heldContext, null);
    assert.equal(state.ui.pageTitleUntilMs, null);
    const dropped = renderScreen(state.project, state.ui, 0, false, Date.now());
    const droppedBare = renderScreen(state.project, { ...state.ui, pageTitleUntilMs: null }, 0, false, Date.now());
    assert.deepEqual(dropped.pixels, droppedBare.pixels);
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    assert.equal(state.ui.pageTitleLane, false);
    assert.equal(state.ui.pageTitleSlide, null);
    frame = paint(state);
    assertOutline(frame.shown, frame.bare, [captionAt(page)]);

    state = reduce(state, { kind: "note", data1: 94, data2: 127 });
    assert.equal(state.ui.page, 2);
    assert.equal(state.ui.pageTitleLane, false);
    const next = pagesFor("bass")[2]?.title ?? "";
    frame = paint(state);
    assertOutline(frame.shown, frame.bare, [captionAt(next)]);

    state = reduce(state, { kind: "note", data1: 20, data2: 0 });
    state = reduce(state, { kind: "note", data1: 16, data2: 127 });
    state = reduce(state, { kind: "note", data1: 16, data2: 0 });
    assert.equal(state.ui.context, "kick");
    state = reduce(state, { kind: "note", data1: 20, data2: 127 });
    assert.equal(state.ui.pageTitleSlide, null);
    assert.equal(state.ui.pageTitleLane, true);
    frame = paint(state);
    assertOutline(frame.shown, frame.bare, [captionAt("BASS", CAPTION_LANE_Y), captionAt(next, CAPTION_PAGE_Y)]);
  });

  it("checks the mixer faders and the dj strip while a caption is up", () => {
    const mix = reduce(openMixer(session()), { kind: "note", data1: 9, data2: 127 });
    mix.project.mixer.kick = 1;
    const mixShown = renderScreen(mix.project, mix.ui, 0);
    const mixBare = renderScreen(mix.project, { ...mix.ui, pageTitleUntilMs: null }, 0);
    assert.equal(mixShown.viz, "mixer");
    const faderBottom = HEIGHT - FONT_H - 1 - FONT_H - 1 - 2;
    const belowCaption = CAPTION_SINGLE_Y + DIGIT_H + CAPTION_OUTLINE;
    let mixCovered = false;
    for (let y = belowCaption; y <= faderBottom; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if ((x + y) % 2 === 0) continue;
        assert.equal(pixel(mixShown, x, y), 0);
        if (pixel(mixBare, x, y) === 1) mixCovered = true;
      }
    }
    assert.ok(mixCovered);

    const deck = reduce(openDeck(session()), { kind: "note", data1: 9, data2: 127 });
    const deckShown = renderScreen(deck.project, deck.ui, 0);
    const deckBare = renderScreen(deck.project, { ...deck.ui, pageTitleUntilMs: null }, 0);
    assert.equal(deckShown.viz, "deck");
    let deckCovered = false;
    for (let y = belowCaption; y <= HEADER_H + VIZ_H - 2; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if ((x + y) % 2 === 0) continue;
        assert.equal(pixel(deckShown, x, y), 0);
        if (pixel(deckBare, x, y) === 1) deckCovered = true;
      }
    }
    assert.ok(deckCovered);
  });

  it("keeps a repaint key moving through a slide and drops it when the caption ends", () => {
    let state = reduce(session(), { kind: "note", data1: 9, data2: 127 });
    const touched = state.ui.pageTitleUntilMs ?? 0;
    assert.equal(pageTitlePaintKey(state.ui, touched - 1), 0);
    assert.equal(pageTitlePaintKey(state.ui, touched), 0);
    const letGo = reduce(state, { kind: "note", data1: 9, data2: 0 });
    assert.equal(pageTitlePaintKey(letGo.ui, touched - 1), -1);
    const up = settleWheel(letGo.ui, (letGo.ui.wheelReleaseMs ?? 0) + WHEEL_RELEASE_MS);
    assert.equal(pageTitlePaintKey(up, touched), -1);

    state = reduce(state, { kind: "cc", data1: 14, data2: 1 });
    const started = state.ui.pageTitleSlide?.startedMs ?? 0;
    const until = state.ui.pageTitleUntilMs ?? 0;
    assert.equal(pageTitlePaintKey(state.ui, started), 0);
    assert.equal(pageTitlePaintKey(state.ui, started + 40), 40);
    assert.equal(pageTitlePaintKey(state.ui, started + PAGE_TITLE_SLIDE_MS), PAGE_TITLE_SLIDE_MS);
    assert.equal(pageTitlePaintKey(state.ui, started + PAGE_TITLE_SLIDE_MS + 50), PAGE_TITLE_SLIDE_MS);
    assert.ok(until > started + PAGE_TITLE_SLIDE_MS);
    assert.equal(pageTitlePaintKey(state.ui, until), PAGE_TITLE_SLIDE_MS);
    const letGoSlide = reduce(state, { kind: "note", data1: 9, data2: 0 });
    assert.equal(pageTitlePaintKey(letGoSlide.ui, until), -1);
    const upSlide = settleWheel(letGoSlide.ui, (letGoSlide.ui.wheelReleaseMs ?? 0) + WHEEL_RELEASE_MS);
    assert.equal(pageTitlePaintKey(upSlide, until), -1);
  });
});

