import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { SAMPLE_RATE } from "../src/core/clock.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { LANES, type LaneId } from "../src/core/types.ts";
import { createDeckRuntime, formatWavePage, noteDeck, parseWavePage, pastColumns } from "../src/dsp/deck.ts";
import { createEngine, loadPhrase, placeClock, renderDryBlock } from "../src/dsp/voice.ts";
import { WIDTH } from "../src/ui/screen.ts";
import { applyWavePages, drawWaveform, emptyWave, waveAt, wavePeak, WAVE_HOP, type WaveTape } from "../src/ui/wave.ts";
import { resetWaveform, serviceWaveform, waveformTape } from "../src/ui/wave-audio.ts";

function pixelsOf(tape: WaveTape, head: number): Uint8Array {
  const pixels = new Uint8Array(WIDTH * 32);
  drawWaveform(pixels, WIDTH, tape, {
    x: 0,
    y: 0,
    w: WIDTH,
    h: 32,
    head,
    span: 88200,
    stylus: true,
  });
  return pixels;
}

function lit(pixels: Uint8Array, x: number, y: number): number {
  return pixels[y * WIDTH + x] ?? 0;
}

function onlyLane(lane: LaneId): ReturnType<typeof defaultProject> {
  const project = clone(defaultProject());
  for (const id of LANES) project.mute[id] = id !== lane;
  return project;
}

/** Level one moment after the first hit, relative to that hit. */
function remain(tape: WaveTape, seconds: number): number {
  const hop = tape.hop;
  let origin = -1;
  let peak = 0;
  for (let s = 0; s < tape.period; s += hop) {
    const v = (tape.left.get(s) ?? 0) + (tape.right.get(s) ?? 0);
    if (v > 0.08) {
      origin = s;
      peak = v;
      break;
    }
  }
  if (origin < 0 || !(peak > 0)) return 0;
  const later = origin + Math.round(seconds * SAMPLE_RATE);
  const key = Math.floor(fold(later, tape.period) / hop) * hop;
  const v = (tape.left.get(key) ?? 0) + (tape.right.get(key) ?? 0);
  return v / peak;
}

function fold(sample: number, period: number): number {
  const wrapped = sample % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

describe("waveform", () => {
  it("stores the next frame at the requested sample", () => {
    const engine = createEngine();
    loadPhrase(engine, [], 120, true);
    placeClock(engine, 128);
    renderDryBlock(engine, 128);
    assert.equal(engine.clock, 255);
    placeClock(engine, 1);
    renderDryBlock(engine, 128);
    assert.equal(engine.clock, 128);
  });

  it("draws left up and right down, and scrolls the tape under the center", () => {
    const tape = emptyWave();
    for (let hop = 0; hop < 8; hop++) {
      tape.left.set(17920 + hop * 128, 1);
      tape.right.set(17920 + hop * 128, 0.25);
    }
    const pixels = pixelsOf(tape, 0);
    const mid = Math.floor(31 / 2);
    let above = 0;
    let below = 0;
    for (let x = 80; x < 100; x++) {
      for (let y = 0; y < mid; y++) if (lit(pixels, x, y)) above++;
      for (let y = mid + 1; y < 32; y++) if (lit(pixels, x, y)) below++;
    }
    assert.ok(above > below);
    assert.ok(above > 8);
    assert.equal(lit(pixels, 64, mid), 0);
    assert.equal(lit(pixels, 63, mid), 1);
    const later = pixelsOf(tape, 5513);
    let moved = 0;
    for (let i = 0; i < pixels.length; i++) if (pixels[i] !== later[i]) moved++;
    assert.ok(moved > 10);
  });

  it("folds the future into the phrase and leaves an empty ring silent", () => {
    const tape = emptyWave(128, 1024);
    tape.left.set(0, 1);
    tape.right.set(0, 0.2);
    tape.left.set(896, 0.4);
    tape.right.set(896, 0.8);
    const future = wavePeak(tape, 0, 200, 0);
    assert.ok(future.left > future.right);
    assert.equal(wavePeak(tape, 1024, 1200, 1024).left, 1);
    assert.equal(wavePeak(tape, -200, -1, 0).left, 0);
    assert.equal(wavePeak(tape, -200, -1, 0).right, 0);
  });

  it("packs recorded ring peaks on the left and stays empty before the first write", () => {
    const deck = createDeckRuntime();
    const head = 4000;
    const span = 88200;
    const silent = pastColumns(deck, head, span);
    assert.equal(silent.length, 64);
    assert.ok(silent.every((col) => col.left === 0 && col.right === 0));
    noteDeck(deck, head - 1000, 0.9, -0.4);
    const cols = pastColumns(deck, head, span);
    assert.ok(cols.some((col) => col.left > 0.85 && col.right > 0.35));
    const far = pastColumns(deck, head + span, span);
    assert.ok(far.every((col) => col.left === 0 && col.right === 0));
    const pages = [formatWavePage(0, head, span, cols), formatWavePage(1, head, span, cols)];
    const parsed = pages.map((text) => parseWavePage(text));
    assert.ok(parsed[0] && parsed[1]);
    assert.equal(parsed[0].head, head);
    assert.equal(parsed[1].span, span);
    assert.equal(parsed[0].cols.length + parsed[1].cols.length, 64);
    const restored = [...parsed[0].cols, ...parsed[1].cols];
    const hot = restored.find((col) => col.left > 0.8);
    assert.ok(hot);
    assert.ok(hot.right > 0.3);
    assert.equal(parseWavePage("0|1|2|abc"), null);
    const tape = emptyWave(WAVE_HOP, span);
    tape.left.set(0, 1);
    applyWavePages(tape, pages);
    const behind = waveAt(tape, head - 1000, head);
    assert.ok((behind?.left ?? 0) > 0.8);
    assert.ok((behind?.left ?? 0) < 1);
  });

  it("shows the event ahead of the needle and does not copy the previous beat", () => {
    const tape = emptyWave(128, 8192);
    tape.left.set(0, 1);
    tape.right.set(0, 0.2);
    tape.left.set(4096, 0.25);
    tape.right.set(4096, 0.9);
    const head = 4096;
    const beat = 1024;
    assert.equal(waveAt(tape, head, head)?.left, 0.25);
    assert.equal(waveAt(tape, head, head)?.right, 0.9);
    assert.equal(waveAt(tape, head - beat, head), null);
    assert.equal(waveAt(tape, head + beat, head), null);
    assert.equal(waveAt(tape, head + 4096, head)?.left, 1);
    resetWaveform();
    const project = onlyLane("kick");
    const sketch = serviceWaveform(project);
    assert.equal(sketch, waveformTape());
    assert.ok(sketch.period > 0);
    const ahead = wavePeak(sketch, 0, Math.floor(sketch.period / 2), 0);
    assert.ok(ahead.left + ahead.right > 0.05, `ahead ${ahead.left} ${ahead.right}`);
    const behind = wavePeak(sketch, -Math.floor(sketch.period / 4), -1, 0);
    assert.equal(behind.left, 0);
    assert.equal(behind.right, 0);
  });

  it("uses the voice decay, so a short kick is shorter and hat ring lengthens the body", () => {
    resetWaveform();
    const shortKick = onlyLane("kick");
    shortKick.working.kick.sound.decay.value = 0;
    const short = remain(serviceWaveform(shortKick), 0.25);
    resetWaveform();
    const longKick = onlyLane("kick");
    longKick.working.kick.sound.decay.value = 1;
    const long = remain(serviceWaveform(longKick), 0.25);
    assert.ok(short < 0.15, `short ${short}`);
    assert.ok(long > 0.4, `long ${long}`);
    resetWaveform();
    const tightHat = onlyLane("hat");
    tightHat.working.hat.sound.decay.value = 0;
    tightHat.working.hat.sound.ring.value = 0;
    const tight = remain(serviceWaveform(tightHat), 0.05);
    resetWaveform();
    const openHat = onlyLane("hat");
    openHat.working.hat.sound.decay.value = 0;
    openHat.working.hat.sound.ring.value = 1;
    const open = remain(serviceWaveform(openHat), 0.05);
    assert.ok(open > tight + 0.15, `tight ${tight} open ${open}`);
  });

  it("keeps the collage when a deck knob moves", () => {
    resetWaveform();
    const project = defaultProject();
    const tape = serviceWaveform(project);
    const decked = clone(project);
    decked.deck.div = decked.deck.div === 0 ? 1 : 0;
    assert.equal(serviceWaveform(decked), tape);
    const quieter = clone(project);
    quieter.mixer = { ...quieter.mixer, master: 0 };
    const rebuilt = serviceWaveform(quieter);
    assert.notEqual(rebuilt, tape);
    assert.equal(rebuilt.past, null);
  });
});
