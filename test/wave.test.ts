import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clone } from "../src/core/clone.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { barSamples, samplesPerBeat } from "../src/core/deck.ts";
import { createEngine, loadPhrase, placeClock, renderDryBlock } from "../src/dsp/voice.ts";
import { WIDTH } from "../src/ui/screen.ts";
import { drawWaveform, emptyWave, waveAt, wavePeak, type WaveTape } from "../src/ui/wave.ts";
import { fillWaveform, resetWaveform, serviceWaveform, waveformCovers, waveformTape } from "../src/ui/wave-audio.ts";

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

  it("folds the loop so both sides of the needle are the phrase", () => {
    const tape = emptyWave(128, 1024);
    tape.left.set(0, 1);
    tape.right.set(0, 0.2);
    tape.left.set(896, 0.4);
    tape.right.set(896, 0.8);
    const future = wavePeak(tape, 0, 200);
    const past = wavePeak(tape, -200, -1);
    assert.ok(future.left > future.right);
    assert.ok(past.right > past.left);
    assert.equal(wavePeak(tape, 1024, 1200).left, 1);
  });

  it("keeps the past up and copies it onto the next beats", () => {
    const beat = 1024;
    const held = emptyWave(128, 8192);
    held.left.set(0, 1);
    held.right.set(0, 0.25);
    held.left.set(512, 0.4);
    held.right.set(512, 0.8);
    held.left.set(4096, 0.9);
    const tape = emptyWave(128, 8192);
    tape.held = held;
    const head = 1024;
    assert.equal(waveAt(tape, head - beat, head, beat)?.left, 1);
    assert.equal(waveAt(tape, head - beat, head, beat)?.right, 0.25);
    assert.equal(waveAt(tape, head - 512, head, beat)?.left, 0.4);
    assert.equal(waveAt(tape, head - 512, head, beat)?.right, 0.8);
    const ahead = waveAt(tape, head + 512, head, beat);
    assert.equal(ahead?.left, 0.4);
    assert.equal(ahead?.right, 0.8);
    assert.notEqual(waveAt(tape, head + beat, head, beat)?.left, 0.9);
    tape.left.set(head + 512, 0.15);
    tape.right.set(head + 512, 0.05);
    assert.equal(waveAt(tape, head + 512, head, beat)?.left, 0.15);
  });

  it("draws the past from the phrase before any block is rendered", () => {
    resetWaveform();
    const project = defaultProject();
    const span = barSamples(project.global.tempo, project.global.bar);
    const beat = Math.max(1, Math.round(samplesPerBeat(project.global.tempo)));
    const head = span;
    const tape = serviceWaveform(project, head, span, 0);
    const recent = Math.floor((head - beat) / 128) * 128;
    assert.equal(tape.left.has(recent), false);
    assert.ok((waveAt(tape, head - beat, head, beat)?.left ?? 0) > 0);
    const past = wavePeak(tape, head - span / 2, head, head, beat);
    const future = wavePeak(tape, head, head + Math.floor(span / 2), head, beat);
    assert.ok(past.left + past.right > 0.15, `past ${past.left} ${past.right}`);
    assert.ok(future.left + future.right > 0.05, `future ${future.left} ${future.right}`);
    const pixels = new Uint8Array(WIDTH * 32);
    drawWaveform(pixels, WIDTH, tape, { x: 0, y: 0, w: WIDTH, h: 32, head, span, beat, stylus: true });
    const mid = Math.floor(31 / 2);
    let leftLit = 0;
    for (let x = 0; x < WIDTH / 2 - 1; x++) {
      for (let y = 0; y < mid; y++) if ((pixels[y * WIDTH + x] ?? 0) > 0) leftLit++;
    }
    assert.ok(leftLit > 20, `left ${leftLit}`);
  });

  it("builds a continuous loop with audio behind and ahead of the needle", () => {
    resetWaveform();
    const project = defaultProject();
    const span = barSamples(project.global.tempo, project.global.bar);
    const tape = fillWaveform(project, span / 2, span);
    assert.equal(tape, waveformTape());
    assert.ok(waveformCovers());
    assert.ok(tape.period >= span);
    const peaks = [...tape.left.values()];
    assert.ok(peaks.length > 100);
    const max = Math.max(...peaks);
    const min = Math.min(...peaks);
    assert.ok(max > 0.05, `max ${max}`);
    assert.ok(max > min * 4, `max ${max} min ${min}`);
    const head = tape.period * 5 + Math.floor(tape.period / 2);
    const behind = wavePeak(tape, head - span / 2, head);
    const ahead = wavePeak(tape, head, head + span / 2);
    assert.ok(behind.left + behind.right > 0.02, `behind ${behind.left} ${behind.right}`);
    assert.ok(ahead.left + ahead.right > 0.02, `ahead ${ahead.left} ${ahead.right}`);
    const before = wavePeak(tape, -span / 2, -1);
    assert.ok(before.left + before.right > 0.02, `before ${before.left} ${before.right}`);
    const body = peaks.filter((peak) => peak > max * 0.08 && peak < max * 0.85);
    assert.ok(body.length > 15, `body hops ${body.length} of ${peaks.length}`);
    const pixels = pixelsOf(tape, head);
    const mid = Math.floor(31 / 2);
    let thick = 0;
    for (let x = 0; x < WIDTH; x++) {
      if (x === 64) continue;
      let height = 0;
      for (let y = 0; y < mid; y++) if (lit(pixels, x, y)) height++;
      if (height >= 3) thick++;
    }
    assert.ok(thick > 12, `thick columns ${thick}`);
    const beat = Math.max(1, Math.round(samplesPerBeat(project.global.tempo)));
    const needle = tape.period / 2;
    const decked = clone(project);
    decked.deck.div = decked.deck.div === 0 ? 1 : 0;
    assert.equal(serviceWaveform(decked, needle, span), tape);
    assert.equal(waveformCovers(), true);
    const quieter = clone(project);
    quieter.mixer = { ...quieter.mixer, master: 0 };
    const rebuilt = serviceWaveform(quieter, needle, span);
    assert.ok(rebuilt.held);
    const pastSample = needle - span / 4;
    assert.deepEqual(waveAt(rebuilt, pastSample, needle, beat), waveAt(tape, pastSample, needle, 0));
    assert.equal(rebuilt.left.has(Math.floor((needle + beat) / 128) * 128), false);
    assert.deepEqual(waveAt(rebuilt, needle + beat, needle, beat), waveAt(tape, needle - beat, needle, 0));
  });
});
