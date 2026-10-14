import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIXTEENTH_TICKS, tickToSample } from "../src/core/clock.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { mapKick, mapSound } from "../src/dsp/map.ts";
import { eventsInBlock, phraseLoop, soundMotions } from "../src/dsp/schedule.ts";
import { createEngine, loadPhrase, packBlock, packPhrase, renderBlock, renderClock } from "../src/dsp/voice.ts";

describe("dsp adapter", () => {
  it("maps kick semantics onto v01 chain keys", () => {
    const params = mapKick({
      pitch: 0.2,
      bend: 0.3,
      snap: 0.4,
      click: 0.5,
      decay: 0.6,
      noise: 0.7,
      drive: 0.8,
      tone: 0.9,
    });
    const byId = Object.fromEntries(params.map((param) => [param.id, param.value]));
    assert.equal(byId.v01_freq, 0.2);
    assert.equal(byId.v01_dcy, 0.6);
    assert.equal(byId.v01_dist, 0.8);
    assert.equal(params.length, 8);
  });

  it("uses surge chain keys for cutoff and keeps chords polyphonic params distinct", () => {
    const bass = mapSound("bass", { cutoff: 0.4, shape: 0.5, decay: 0.2, attack: 0.1, resonance: 0.3, detune: 0, fm: 0, noise: 0 });
    assert.ok(bass.some((param) => param.id === "cutoff" && param.value === 0.4));
    const chords = mapSound("chords", { width: 0.6, cutoff: 0.2, shape: 0, detune: 0, fm: 0, resonance: 0, attack: 0, release: 0 });
    assert.ok(chords.some((param) => param.id === "osc_width"));
  });

  it("schedules the downbeat kick inside the first audio block", () => {
    const project = defaultProject();
    const block = eventsInBlock(project, 0);
    const kick = block.filter((event) => event.lane === "kick");
    assert.ok(kick.length >= 1);
    assert.equal(kick[0].sampleOffset, 0);
    assert.equal(kick[0].note, 36);
    assert.ok(kick[0].params.some((param) => param.id === "v01_freq"));
  });

  it("sounds the kick, pans the hat, and widens chords with osc_width", () => {
    const project = defaultProject();
    const engine = createEngine();
    const first = renderBlock(engine, eventsInBlock(project, 0), project.global.tempo);
    const again = renderBlock(createEngine(), eventsInBlock(project, 0), project.global.tempo);
    assert.deepEqual(first, again);
    let energy = 0;
    for (const sample of first) energy += Math.abs(sample);
    assert.ok(energy > 0.05);

    const leftHat = renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "hat", note: 42, velocity: 100, lengthTicks: 48,
      params: mapSound("hat", { pitch: 0.5, click: 0.8, snap: 0.2, decay: 0.5, tone: 0.7, drive: 0.1, pan: 0, spread: 0 }),
    }], 120);
    let left = 0;
    let right = 0;
    for (let i = 0; i < 128; i++) {
      left += Math.abs(leftHat[i * 2]);
      right += Math.abs(leftHat[i * 2 + 1]);
    }
    assert.ok(left > right * 2);

    const narrow = sideDifference(0);
    const wide = sideDifference(1);
    assert.ok(wide > narrow);
    assert.match(packBlock(eventsInBlock(project, 0), 120), /^120\|/);
  });

  it("loops the phrase on the audio clock and spaces cycle 4 by a quarter note", () => {
    const project = defaultProject();
    const hits = phraseLoop(project);
    const kicks = hits.filter((event) => event.lane === "kick").map((event) => event.sample);
    const quarter = tickToSample(4 * SIXTEENTH_TICKS, project.global.tempo);
    assert.ok(kicks.length > 2);
    assert.equal(kicks[0], 0);
    assert.equal(kicks[1] - kicks[0], quarter);
    assert.ok(hits.length < 512);
    assert.ok(packPhrase(hits, 120, true, soundMotions(project)).length < 60000);

    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0, loop: 300, lane: "kick", note: 36, velocity: 120, lengthTicks: 48,
      params: mapSound("kick", { pitch: 0.5, bend: 0, snap: 0, click: 0, decay: 0.05, noise: 0, drive: 0, tone: 0.5 }),
    }], 120, true);
    renderClock(engine);
    const ageFirst = engine.drums[0].age;
    renderClock(engine);
    const ageMid = engine.drums[0].age;
    renderClock(engine);
    assert.ok(ageMid > ageFirst);
    assert.ok(engine.drums[0].age < ageMid);
  });

  it("keeps default bass audible through a slow attack", () => {
    const project = defaultProject();
    for (const lane of ["kick", "snare", "hat", "perc", "lead", "chords"] as const) project.mute[lane] = true;
    const engine = createEngine();
    loadPhrase(engine, phraseLoop(project), project.global.tempo, true, soundMotions(project));
    let peak = 0;
    for (let i = 0; i < 80; i++) {
      const buf = renderClock(engine);
      for (const sample of buf) peak = Math.max(peak, Math.abs(sample));
    }
    assert.ok(peak > 0.01);
    assert.ok(engine.notes.some((note) => note.on || note.age > 100));
  });

  it("moves cutoff across a held note", () => {
    const tempo = 120;
    const sixteenth = tickToSample(SIXTEENTH_TICKS, tempo);
    const loop = sixteenth * 8;
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0,
      loop,
      lane: "bass",
      note: 40,
      velocity: 100,
      lengthTicks: 16 * 48,
      params: mapSound("bass", { shape: 0.2, detune: 0.5, fm: 0, noise: 0, cutoff: 0, resonance: 0, attack: 0, decay: 0.8 }),
    }], tempo, true, [{
      lane: "bass", id: "cutoff", value: 0, pattern: 0, cycle: 8, amount: 1, loop,
    }]);
    renderClock(engine);
    assert.ok(engine.notes[0].cutoff < 0.2);
    let heard = 128;
    while (heard < sixteenth * 2) {
      renderClock(engine);
      heard += 128;
    }
    assert.ok(engine.notes[0].cutoff > 0.9);
  });

  it("holds drum pitch at the value from the hit", () => {
    const project = defaultProject();
    assert.equal(soundMotions(project).some((motion) => motion.id.endsWith("freq")), false);
    const tempo = 120;
    const sixteenth = tickToSample(SIXTEENTH_TICKS, tempo);
    const loop = sixteenth * 8;
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0,
      loop,
      lane: "kick",
      note: 36,
      velocity: 120,
      lengthTicks: 48,
      params: mapSound("kick", { pitch: 0.2, bend: 0, snap: 0, click: 0, decay: 0.7, noise: 0, drive: 0, tone: 0.5 }),
    }], tempo, true, [{
      lane: "kick", id: "v01_freq", value: 0.2, pattern: 0, cycle: 8, amount: 1, loop,
    }]);
    renderClock(engine);
    const freq = engine.drums[0].freq;
    let heard = 128;
    while (heard < sixteenth * 2) {
      renderClock(engine);
      heard += 128;
    }
    assert.equal(engine.drums[0].freq, freq);
  });

  it("maps every snare suffix onto a distinct live field", () => {
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0, loop: 100000, lane: "snare", note: 38, velocity: 100, lengthTicks: 48,
      params: mapSound("snare", {
        pitch: 0.2, body: 0.31, noise: 0.42, snap: 0.53, decay: 0.64, tail: 0.75, click: 0.86, drive: 0.97,
      }),
    }], 120, true);
    renderClock(engine);
    const drum = engine.drums[1];
    assert.ok(Math.abs(drum.freq - drum.base * 0.7) < 1e-6);
    assert.equal(drum.body, 0.31);
    assert.equal(drum.noise, 0.42);
    assert.equal(drum.snap, 0.53);
    assert.ok(Math.abs(drum.decay - (0.005 + 0.64 * 0.64 * 0.95)) < 1e-6);
    assert.ok(Math.abs(drum.noiseDecay - (0.004 + 0.75 * 0.75 * 0.86)) < 1e-6);
    assert.equal(drum.bright, 0.86);
    assert.equal(drum.drive, 0.97);
  });

  it("keeps kick snap and click as separate controls", () => {
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0, loop: 100000, lane: "kick", note: 36, velocity: 120, lengthTicks: 48,
      params: mapSound("kick", {
        pitch: 0.5, bend: 0.2, snap: 0.9, click: 0.1, decay: 0.5, noise: 0.2, drive: 0.1, tone: 0.5,
      }),
    }], 120, true);
    renderClock(engine);
    assert.equal(engine.drums[0].snap, 0.9);
    assert.equal(engine.drums[0].bright, 0.1);
    assert.equal(engine.drums[0].bend, 0.2);
  });

  it("changes early energy when snap or body moves", () => {
    const quietSnap = peak(renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "snare", note: 38, velocity: 120, lengthTicks: 48,
      params: mapSound("snare", { pitch: 0.5, body: 0.8, noise: 0.2, snap: 0, decay: 0.5, tail: 0.4, click: 0.5, drive: 0 }),
    }], 120));
    const loudSnap = peak(renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "snare", note: 38, velocity: 120, lengthTicks: 48,
      params: mapSound("snare", { pitch: 0.5, body: 0.8, noise: 0.2, snap: 1, decay: 0.5, tail: 0.4, click: 0.5, drive: 0 }),
    }], 120));
    assert.ok(loudSnap > quietSnap);

    const thin = peak(renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "snare", note: 38, velocity: 120, lengthTicks: 48,
      params: mapSound("snare", { pitch: 0.5, body: 0, noise: 0.1, snap: 0, decay: 0.6, tail: 0.3, click: 0.2, drive: 0 }),
    }], 120));
    const fat = peak(renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "snare", note: 38, velocity: 120, lengthTicks: 48,
      params: mapSound("snare", { pitch: 0.5, body: 1, noise: 0.1, snap: 0, decay: 0.6, tail: 0.3, click: 0.2, drive: 0 }),
    }], 120));
    assert.ok(fat > thin);
  });

  it("spreads pitched detune, fm and resonance into the note voice", () => {
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0, loop: 100000, lane: "bass", note: 40, velocity: 100, lengthTicks: 192,
      params: mapSound("bass", { shape: 0.8, detune: 0.9, fm: 0.7, noise: 0.4, cutoff: 0.6, resonance: 0.85, attack: 0.1, decay: 0.5 }),
    }], 120, true);
    renderClock(engine);
    const note = engine.notes[0];
    assert.equal(note.shape, 0.8);
    assert.equal(note.detune, 0.9);
    assert.equal(note.fm, 0.7);
    assert.equal(note.noise, 0.4);
    assert.equal(note.resonance, 0.85);
  });

  it("keeps musical sound defaults off the old 0.5 parking lot for drums and pitched lanes", () => {
    const project = defaultProject();
    assert.equal(project.working.kick.sound.drive.value < 0.3, true);
    assert.equal(project.working.bass.sound.fm.value < 0.2, true);
    assert.equal(project.working.bass.sound.noise.value < 0.1, true);
    assert.equal(project.working.lead.sound.attack.value < 0.1, true);
    assert.equal(project.working.chords.sound.fm.value, 0.5);
  });
});

function peak(buf: Float32Array): number {
  let best = 0;
  for (let i = 0; i < Math.min(buf.length, 256); i++) {
    const a = Math.abs(buf[i]);
    if (a > best) best = a;
  }
  return best;
}

function sideDifference(width: number): number {
  const audio = renderBlock(createEngine(), [{
    sampleOffset: 0, lane: "chords", note: 64, velocity: 110, lengthTicks: 192,
    params: mapSound("chords", { shape: 0.8, detune: 0.5, fm: 0, width, cutoff: 0.9, resonance: 0.1, attack: 0, release: 0.8 }),
  }], 120);
  let diff = 0;
  for (let i = 0; i < 128; i++) diff += Math.abs(audio[i * 2] - audio[i * 2 + 1]);
  return diff;
}