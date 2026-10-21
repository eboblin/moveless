import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIXTEENTH_TICKS, tickToSample } from "../src/core/clock.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { evalModulated } from "../src/core/modulate.ts";
import { applyMorph } from "../src/core/morph.ts";
import { clone } from "../src/core/clone.ts";
import { launchScene, record } from "../src/core/performance.ts";
import { mapFilter, mapKick, mapSend, mapSound } from "../src/dsp/map.ts";
import { eventsInBlock, phraseLoop, soundMotions } from "../src/dsp/schedule.ts";
import { createEngine, filterSample, formatBus, loadPhrase, packBlock, packPhrase, packPhraseBody, renderBlock, renderClock } from "../src/dsp/voice.ts";
import type { BlockEvent } from "../src/dsp/schedule.ts";
import type { LaneId } from "../src/core/types.ts";

describe("dsp adapter", () => {
  it("maps kick semantics onto v01 chain keys", () => {
    const params = mapKick({
      pitch: 0.2,
      decay: 0.6,
      bend: 0.3,
      bendTime: 0.4,
      body: 0.15,
      click: 0.5,
      noise: 0.7,
      drive: 0.8,
    });
    const byId = Object.fromEntries(params.map((param) => [param.id, param.value]));
    assert.equal(byId.v01_freq, 0.2);
    assert.equal(byId.v01_decay, 0.6);
    assert.equal(byId.v01_pbend, 0.3);
    assert.equal(byId.v01_btime, 0.4);
    assert.equal(byId.v01_body, 0.15);
    assert.equal(byId.v01_click, 0.5);
    assert.equal(byId.v01_noise, 0.7);
    assert.equal(byId.v01_dist, 0.8);
    assert.equal(params.length, 8);
  });

  it("maps the lane filter beside the wavetable and keeps chord wide distinct", () => {
    const bass = mapSound("bass", { wave: 0.36, release: 0.2, attack: 0.1, bend: 0, sync: 0, fold: 0, drive: 0, wide: 0 });
    assert.equal(bass.some((param) => param.id === "cutoff"), false);
    assert.ok(bass.some((param) => param.id === "wave"));
    const filter = mapFilter({ cutoff: 0.4, resonance: 0.3 });
    assert.deepEqual(filter, [
      { id: "cutoff", value: 0.4 },
      { id: "resonance", value: 0.3 },
    ]);
    const chords = mapSound("chords", { wide: 0.6, wave: 0, bend: 0, sync: 0, fold: 0, drive: 0, attack: 0, release: 0 });
    assert.ok(chords.some((param) => param.id === "wide"));
  });

  it("bypasses the lane filter at 50 and cuts lows or highs toward the ends", () => {
    const dry = { low: 0.2, band: 0.4 };
    assert.equal(filterSample(dry, 0.4, 0.5, 1), 0.4);
    assert.equal(dry.low, 0);
    assert.equal(dry.band, 0);
    const tone = (freq: number, cutoff: number) => {
      const state = { low: 0, band: 0 };
      let energy = 0;
      for (let i = 0; i < 8000; i++) {
        const input = Math.sin((2 * Math.PI * freq * i) / 44100);
        const out = filterSample(state, input, cutoff, 0);
        if (i > 4000) energy += out * out;
      }
      return energy;
    };
    assert.ok(tone(80, 0) < tone(80, 0.5) * 0.25);
    assert.ok(tone(8000, 1) < tone(8000, 0.5) * 0.25);
    const saw = (cutoff: number) => {
      const state = { low: 0, band: 0 };
      let energy = 0;
      for (let i = 0; i < 8000; i++) {
        const input = ((i * 110) / 44100) % 1 * 2 - 1;
        const out = filterSample(state, input, cutoff, 0);
        if (i > 4000) energy += out * out;
      }
      return energy;
    };
    const open = saw(0.5);
    assert.ok(saw(0.3) > open * 0.5);
    assert.ok(saw(0.8) > open * 0.5);
  });

  it("rings an acid peak on the low-pass corner without lifting the note under it", () => {
    const sine = (freq: number, cutoff: number, resonance: number) => {
      const state = { low: 0, band: 0 };
      let energy = 0;
      let peak = 0;
      for (let i = 0; i < 12000; i++) {
        const input = Math.sin((2 * Math.PI * freq * i) / 44100);
        const out = filterSample(state, input, cutoff, resonance);
        assert.ok(Number.isFinite(out));
        if (i > 4000) {
          energy += out * out;
          peak = Math.max(peak, Math.abs(out));
        }
      }
      return { energy, peak };
    };
    const shaped = 0.7 * 0.7;
    const corner = 12000 * (90 / 12000) ** shaped;
    const quiet = sine(corner, 0.85, 0).energy;
    const mid = sine(corner, 0.85, 0.5).energy;
    const acid = sine(corner, 0.85, 1);
    assert.ok(mid > quiet * 4);
    assert.ok(acid.energy > quiet * 8);
    assert.ok(acid.peak < 2.3);
    const under = sine(80, 0.85, 0).energy;
    assert.ok(sine(80, 0.85, 1).energy < under * 4);
  });

  it("stays dry with the sends closed and rings after the note when one is open", () => {
    const params = [
      ...mapSound("bass", { wave: 0.42, bend: 0, sync: 0, fold: 0, drive: 0, wide: 0, attack: 0, release: 0 }),
      ...mapFilter({ cutoff: 0.7, resonance: 0.2 }),
      ...mapSend({ reverb: 0, delay: 0 }),
    ];
    const hit = {
      sampleOffset: 0, lane: "bass" as const, note: 36, velocity: 110, lengthTicks: 24, params,
    };
    const tail = (buffer: Float32Array) => {
      let energy = 0;
      for (let i = 16000 * 2; i < buffer.length; i++) energy += buffer[i] * buffer[i];
      return energy;
    };
    const dry = renderBlock(createEngine(), [hit], 120, 22000);
    const engine = createEngine();
    engine.fx.reverb.decay = 0.95;
    engine.fx.reverb.level = 1;
    engine.fx.reverb.size = 0.6;
    const wet = renderBlock(engine, [{
      ...hit,
      params: params.map((param) => param.id === "reverb" ? { ...param, value: 1 } : param),
    }], 120, 22000);
    assert.ok(tail(dry) < 1e-3);
    assert.ok(tail(wet) > tail(dry) + 0.05);
    for (const sample of wet) assert.ok(Number.isFinite(sample));
  });

  it("schedules the downbeat kick inside the first audio block", () => {
    const project = defaultProject();
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
    const block = eventsInBlock(project, 0);
    const kick = block.filter((event) => event.lane === "kick");
    assert.ok(kick.length >= 1);
    assert.equal(kick[0].sampleOffset, 0);
    assert.equal(kick[0].note, 36);
    assert.ok(kick[0].params.some((param) => param.id === "v01_freq"));
  });

  it("sounds the kick, pans the hat, and widens chords", () => {
    const project = defaultProject();
    const engine = createEngine();
    const first = renderBlock(engine, eventsInBlock(project, 0), project.global.tempo);
    const again = renderBlock(createEngine(), eventsInBlock(project, 0), project.global.tempo);
    assert.deepEqual(first, again);
    let energy = 0;
    for (const sample of first) energy += Math.abs(sample);
    assert.ok(energy > 0.05);

    const wideHat = renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "hat", note: 42, velocity: 100, lengthTicks: 48,
      params: mapSound("hat", { pitch: 0.6, metal: 0.85, noise: 0.2, color: 0.6, decay: 0.4, attack: 0.3, ring: 0.4, pos: 0 }),
    }], 120);
    const narrowHat = renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "hat", note: 42, velocity: 100, lengthTicks: 48,
      params: mapSound("hat", { pitch: 0.6, metal: 0.85, noise: 0.2, color: 0.6, decay: 0.4, attack: 0.3, ring: 0.4, pos: 0.5 }),
    }], 120);
    const side = (buf: Float32Array) => {
      let diff = 0;
      for (let i = 0; i < 128; i++) diff += Math.abs(buf[i * 2] - buf[i * 2 + 1]);
      return diff;
    };
    assert.ok(side(wideHat) > side(narrowHat) * 2);

    const narrow = sideDifference(0);
    const wide = sideDifference(1);
    assert.ok(wide > narrow);
    assert.match(packBlock(eventsInBlock(project, 0), 120), /^120\|/);
  });

  it("loops the phrase on the audio clock and spaces cycle 4 by a quarter note", () => {
    const project = defaultProject();
    project.working.kick.gen1 = { ...project.working.kick.gen1, length: 16, hits: 4, rotate: 0, probability: 1 };
    project.working.kick.gen2.hits = 0;
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
      params: mapSound("kick", { pitch: 0.5, bend: 0, bendTime: 0.2, body: 0, click: 0, decay: 0.05, noise: 0, drive: 0 }),
    }], 120, true);
    renderClock(engine);
    const ageFirst = engine.drums[0].age;
    renderClock(engine);
    const ageMid = engine.drums[0].age;
    renderClock(engine);
    assert.ok(ageMid > ageFirst);
    assert.ok(engine.drums[0].age < ageMid);
  });

  it("holds a block chord until its length, then releases", () => {
    const tempo = 120;
    const lengthTicks = 16 * SIXTEENTH_TICKS;
    const gate = tickToSample(lengthTicks, tempo);
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0,
      loop: gate * 4,
      lane: "chords",
      note: 60,
      velocity: 110,
      lengthTicks,
      params: mapSound("chords", {
        shape: 0, detune: 0.5, fm: 0, width: 0, cutoff: 1, resonance: 0, attack: 0.5, release: 0.5,
      }),
    }], tempo, true);
    const late = Math.floor(gate * 0.85);
    for (let i = 0; i < Math.ceil(late / 128); i++) renderClock(engine);
    const held = engine.notes.find((note) => note.on);
    assert.ok(held);
    assert.ok(held.env > 0.9);
    assert.ok(held.left > 0);
    let guard = 0;
    while (held.on && held.left > 0 && guard < 2000) {
      renderClock(engine);
      guard += 1;
    }
    assert.equal(held.left, 0);
    const atGate = held.env;
    for (let i = 0; i < 220; i++) renderClock(engine);
    assert.ok(held.env < atGate * 0.5);
  });

  it("keeps every tone of a block while earlier notes are still releasing", () => {
    const tempo = 120;
    const engine = createEngine();
    const loop = tickToSample(64 * SIXTEENTH_TICKS, tempo);
    const tail = mapSound("lead", { wave: 0.2, attack: 0, release: 1, bend: 0, sync: 0, fold: 0, drive: 0, wide: 0 });
    loadPhrase(engine, Array.from({ length: 12 }, (_, i) => ({
      sample: 0,
      loop,
      lane: "lead" as const,
      note: 36 + i,
      velocity: 100,
      lengthTicks: SIXTEENTH_TICKS,
      params: tail,
    })), tempo, true);
    const pastGate = tickToSample(SIXTEENTH_TICKS, tempo) + 128;
    for (let i = 0; i < Math.ceil(pastGate / 128); i++) renderClock(engine);
    assert.equal(engine.notes.filter((note) => note.on).length, 12);

    const chord = mapSound("chords", { wave: 0.2, attack: 0, release: 1, bend: 0, sync: 0, fold: 0, drive: 0, wide: 0 });
    renderBlock(engine, [60, 64, 67].map((note) => ({
      sampleOffset: 0,
      lane: "chords" as const,
      note,
      velocity: 110,
      lengthTicks: 8 * SIXTEENTH_TICKS,
      params: chord,
    })), tempo);
    const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
    const held = engine.notes.filter((note) => note.on && note.left > 0);
    for (const midi of [60, 64, 67]) {
      assert.ok(held.some((note) => Math.abs(note.freq - freq(midi)) < 0.01), `missing midi ${midi}`);
    }
  });

  it("starts a rebuilt chord that the clock has already passed", () => {
    const tempo = 120;
    const bar = tickToSample(16 * SIXTEENTH_TICKS, tempo);
    const loop = bar * 4;
    const chord = (sample: number, note: number) => ({
      sample,
      loop,
      lane: "chords" as const,
      note,
      velocity: 100,
      lengthTicks: 16 * SIXTEENTH_TICKS,
      params: [],
    });
    const kick = {
      sample: 0, loop, lane: "kick" as const, note: 36, velocity: 100, lengthTicks: SIXTEENTH_TICKS, params: [],
    };
    const engine = createEngine();
    loadPhrase(engine, [chord(0, 60), chord(bar, 64), kick], tempo, true);
    engine.clock = bar + Math.floor(bar / 2);
    loadPhrase(engine, [chord(0, 60), chord(bar, 67), kick], tempo, false);
    const held = engine.notes.find((note) => note.on);
    assert.ok(held);
    assert.ok(Math.abs(held.freq - 440 * 2 ** ((67 - 69) / 12)) < 0.01);
    assert.ok(held.left < bar);
    assert.ok(held.left > bar / 4);
    assert.equal(engine.drums[0].on, false);
    const age = held.age;
    renderClock(engine);
    loadPhrase(engine, engine.phrase, tempo, false);
    assert.equal(held.age, age + 128);
  });

  it("keeps default bass audible through a slow attack", () => {
    const project = defaultProject();
    for (const lane of ["kick", "snare", "hat", "perc", "lead", "chords"] as const) project.mute[lane] = true;
    const engine = createEngine();
    project.working.bass.gen1 = { ...project.working.bass.gen1, length: 16, hits: 2, rotate: 0, probability: 1 };
    project.working.bass.gen2.hits = 0;
    loadPhrase(engine, phraseLoop(project), project.global.tempo, true, soundMotions(project));
    let peak = 0;
    for (let i = 0; i < 80; i++) {
      const buf = renderClock(engine);
      for (const sample of buf) peak = Math.max(peak, Math.abs(sample));
    }
    assert.ok(peak > 0.01);
    assert.ok(engine.notes.some((note) => note.on || note.age > 100));
  });

  it("plays one live cutoff modulator", () => {
    const tempo = 120;
    const sixteenth = tickToSample(SIXTEENTH_TICKS, tempo);
    const loop = sixteenth * 8;
    const from = { value: 0.2, pattern: 0, cycle: 8, amount: 1 };
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
      lane: "bass",
      id: "cutoff",
      value: from.value,
      pattern: from.pattern,
      cycle: from.cycle,
      amount: from.amount,
      loop,
    }]);
    renderClock(engine);
    const step = 120 / sixteenth;
    assert.ok(Math.abs(engine.notes[0].cutoff - evalModulated(from, step)) < 1e-6);
  });

  it("glides timbre during a morph and does not follow note pitch", () => {
    let project = defaultProject();
    project.working.bass.filter.cutoff.value = 0;
    project.working.bass.filter.cutoff.amount = 0;
    project = record(project);
    project.working.bass.filter.cutoff.value = 1;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "fast";
    project = launchScene(project, "002", 0);
    const midMotions = soundMotions(applyMorph(project, (project.morph?.durationTicks ?? 0) / 2));
    assert.equal(midMotions.some((motion) => motion.id.endsWith("freq")), false);
    const still = midMotions.find((motion) => motion.lane === "bass" && motion.id === "cutoff");
    assert.ok(still);
    assert.ok(Math.abs((still?.value ?? 0) - 0.5) < 1e-9);

    project = defaultProject();
    project.working.bass.filter.cutoff.value = 0.25;
    project.working.bass.filter.cutoff.amount = 0;
    project = record(project);
    project.working.bass.filter.cutoff.amount = 1;
    project.working.bass.filter.cutoff.pattern = 4;
    project.working.bass.filter.cutoff.cycle = 4;
    project.working.bass.filter.cutoff.value = 0.9;
    project = record(project);
    project.working = clone(project.journal[0].lanes);
    project.transition = "fast";
    project = launchScene(project, "002", 0);
    const live = soundMotions(applyMorph(project, (project.morph?.durationTicks ?? 0) / 2)).find((motion) => motion.lane === "bass" && motion.id === "cutoff");
    assert.ok(live);
    assert.equal(live?.pattern, 4);
    assert.equal(live?.cycle, 4);
    assert.ok(Math.abs((live?.value ?? 0) - 0.575) < 1e-9);
    assert.ok(Math.abs((live?.amount ?? 0) - 0.5) < 1e-9);
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

  it("follows a held chord cutoff when amount is zero", () => {
    const tempo = 120;
    const sixteenth = tickToSample(SIXTEENTH_TICKS, tempo);
    const loop = sixteenth * 16;
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0,
      loop,
      lane: "chords",
      note: 60,
      velocity: 100,
      lengthTicks: 16 * 48,
      params: mapSound("chords", { shape: 0.2, detune: 0.5, fm: 0, width: 0, cutoff: 0, resonance: 0, attack: 0, release: 0.8 }),
    }], tempo, true, [{
      lane: "chords", id: "cutoff", value: 0.95, pattern: 0, cycle: 8, amount: 0, loop,
    }]);
    renderClock(engine);
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
      params: mapSound("kick", { pitch: 0.2, bend: 0, bendTime: 0.2, body: 0, click: 0, decay: 0.7, noise: 0, drive: 0 }),
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

  it("gives each drum its own pitch range and keeps bend time off the amp decay", () => {
    const freq = (lane: "kick" | "snare" | "hat" | "perc", pitch: number) => {
      const engine = createEngine();
      loadPhrase(engine, [{
        sample: 0, loop: 100000, lane, note: 36, velocity: 100, lengthTicks: 48,
        params: mapSound(lane, { pitch }),
      }], 120, true);
      renderClock(engine);
      return engine.drums[lane === "kick" ? 0 : lane === "snare" ? 1 : lane === "hat" ? 2 : 3].freq;
    };
    assert.ok(Math.abs(freq("kick", 0) - 32) < 0.01);
    assert.ok(Math.abs(freq("kick", 1) - 180) < 0.05);
    assert.ok(Math.abs(freq("snare", 0) - 140) < 0.05);
    assert.ok(Math.abs(freq("snare", 1) - 900) < 0.2);
    assert.ok(Math.abs(freq("hat", 0) - 250) < 0.05);
    assert.ok(Math.abs(freq("hat", 1) - 4000) < 1);
    assert.ok(Math.abs(freq("perc", 0) - 70) < 0.05);
    assert.ok(Math.abs(freq("perc", 1) - 2500) < 1);

    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0, loop: 100000, lane: "kick", note: 36, velocity: 100, lengthTicks: 48,
      params: mapSound("kick", { decay: 0.9, bendTime: 0.15 }),
    }], 120, true);
    renderClock(engine);
    const kick = engine.drums[0];
    assert.ok(kick.decay > 1);
    assert.ok(kick.bendTime < 0.05);
    assert.ok(kick.decay > kick.bendTime * 10);
  });

  it("maps every snare suffix onto a distinct live field", () => {
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0, loop: 100000, lane: "snare", note: 38, velocity: 100, lengthTicks: 48,
      params: mapSound("snare", {
        pitch: 0.2, body: 0.31, noise: 0.42, snap: 0.53, bodyDecay: 0.64, noiseDecay: 0.75, tone: 0.86, drive: 0.97,
      }),
    }], 120, true);
    renderClock(engine);
    const drum = engine.drums[1];
    const hz = 140 * (900 / 140) ** 0.2;
    assert.ok(Math.abs(drum.freq - hz) < 0.05);
    assert.equal(drum.body, 0.31);
    assert.equal(drum.noise, 0.42);
    assert.equal(drum.click, 0.53);
    assert.ok(Math.abs(drum.decay - (0.04 + 0.64 * 0.64 * 0.76)) < 1e-6);
    assert.ok(Math.abs(drum.noiseDecay - (0.02 + 0.75 * 0.75 * 0.58)) < 1e-6);
    assert.equal(drum.tone, 0.86);
    assert.equal(drum.drive, 0.97);
  });

  it("keeps kick bend and click as separate controls", () => {
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0, loop: 100000, lane: "kick", note: 36, velocity: 120, lengthTicks: 48,
      params: mapSound("kick", {
        pitch: 0.5, bend: 0.2, bendTime: 0.4, body: 0.1, click: 0.7, decay: 0.5, noise: 0.2, drive: 0.1,
      }),
    }], 120, true);
    renderClock(engine);
    assert.equal(engine.drums[0].bend, 0.2 * 3);
    assert.ok(Math.abs(engine.drums[0].bendTime - (0.008 + 0.4 * 0.4 * 0.392)) < 1e-6);
    assert.equal(engine.drums[0].click, 0.7);
  });

  it("changes early energy when snap moves and the body spectrum when body moves", () => {
    const quietSnap = peak(renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "snare", note: 38, velocity: 120, lengthTicks: 48,
      params: mapSound("snare", { pitch: 0.5, body: 0.5, noise: 0.2, snap: 0, bodyDecay: 0.5, noiseDecay: 0.4, tone: 0.5, drive: 0 }),
    }], 120, 512));
    const loudSnap = peak(renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "snare", note: 38, velocity: 120, lengthTicks: 48,
      params: mapSound("snare", { pitch: 0.5, body: 0.5, noise: 0.2, snap: 1, bodyDecay: 0.5, noiseDecay: 0.4, tone: 0.5, drive: 0 }),
    }], 120, 512));
    assert.ok(loudSnap > quietSnap);

    const toneOf = (body: number) => {
      const audio = renderBlock(createEngine(), [{
        sampleOffset: 0, lane: "snare", note: 38, velocity: 120, lengthTicks: 48,
        params: mapSound("snare", { pitch: 0.45, body, noise: 0, snap: 0, bodyDecay: 0.6, noiseDecay: 0, tone: 0.5, drive: 0 }),
      }], 120, 2048);
      let low = 0;
      let high = 0;
      let prev = 0;
      for (let i = 64; i < 512; i++) {
        const s = audio[i * 2];
        low += s * s;
        const d = s - prev;
        high += d * d;
        prev = s;
      }
      return high / Math.max(1e-9, low);
    };
    assert.ok(toneOf(1) > toneOf(0) * 1.4);
  });

  it("keeps a sounding note's length and gives the next note the new one", () => {
    const engine = createEngine();
    const tempo = 120;
    const loop = tickToSample(16 * SIXTEENTH_TICKS, tempo);
    const second = tickToSample(8 * SIXTEENTH_TICKS, tempo);
    const phrase = (lengthTicks: number) => [
      { sample: 0, loop, lane: "bass" as const, note: 40, velocity: 100, lengthTicks, params: [] },
      { sample: second, loop, lane: "bass" as const, note: 52, velocity: 100, lengthTicks, params: [] },
    ];
    loadPhrase(engine, phrase(192), tempo, true);
    renderClock(engine, 128);
    const sounding = engine.notes.find((voice) => voice.on);
    assert.ok(sounding);
    const left = sounding.left;
    loadPhrase(engine, phrase(192 * 4), tempo, false);
    const held = engine.notes.filter((voice) => voice.on);
    assert.equal(held.length, 1);
    assert.equal(held[0].freq, sounding.freq);
    assert.ok(held[0].left <= left && held[0].left > left - 128);
    renderClock(engine, second - engine.clock + 8);
    const next = engine.notes.find((voice) => voice.on && voice.freq !== sounding.freq);
    assert.ok(next);
    const full = tickToSample(192 * 4, tempo);
    assert.ok(next.left > full - 64);
    assert.ok(next.left <= full);
  });

  it("spreads pitched wave, sync and resonance into the note voice", () => {
    const engine = createEngine();
    loadPhrase(engine, [{
      sample: 0, loop: 100000, lane: "bass", note: 40, velocity: 100, lengthTicks: 192,
      params: [
        ...mapSound("bass", { wave: 0.8, bend: 0.2, sync: 0.7, fold: 0.4, drive: 0.3, wide: 0.6, attack: 0.1, release: 0.5 }),
        ...mapFilter({ cutoff: 0.6, resonance: 0.85 }),
      ],
    }], 120, true);
    renderClock(engine);
    const note = engine.notes[0];
    assert.equal(note.wave, 0.8);
    assert.equal(note.sync, 0.7);
    assert.equal(note.fold, 0.4);
    assert.equal(note.wide, 0.6);
    assert.equal(note.resonance, 0.85);
  });

  it("keeps musical sound defaults off the old 0.5 parking lot for drums and pitched lanes", () => {
    const project = defaultProject();
    assert.equal(project.working.kick.sound.drive.value < 0.3, true);
    assert.equal(project.working.bass.sound.sync.value < 0.2, true);
    assert.equal(project.working.bass.sound.fold.value < 0.1, true);
    assert.equal(project.working.bass.sound.wave.value, 0.28);
    assert.equal(project.working.lead.sound.attack.value, 0.23);
    assert.equal(project.working.lead.sound.wide.value, 0);
    assert.equal(project.working.chords.sound.wide.value, 0.4);
    assert.equal(project.working.chords.sound.attack.value, 0);
    assert.equal(project.working.chords.sound.release.value, 0);
  });

  it("puts more edge on a saw and on sync than on a sine", () => {
    const edge = (wave: number, sync: number) => {
      const audio = renderBlock(createEngine(), [{
        sampleOffset: 0, lane: "lead", note: 69, velocity: 110, lengthTicks: 192,
        params: [
          ...mapSound("lead", { wave, bend: 0, sync, fold: 0, drive: 0, wide: 0, attack: 0, release: 1 }),
          ...mapFilter({ cutoff: 0.5, resonance: 0 }),
        ],
      }], 120, 2048);
      let energy = 0;
      for (let i = 400; i < 1800; i++) {
        const d = audio[i * 2] - audio[(i - 1) * 2];
        energy += d * d;
      }
      return energy;
    };
    const sine = edge(0, 0);
    assert.ok(edge(0.42, 0) > sine * 2);
    assert.ok(edge(0, 1) > sine * 2);
    const hot = renderBlock(createEngine(), [{
      sampleOffset: 0, lane: "lead", note: 76, velocity: 120, lengthTicks: 192,
      params: [
        ...mapSound("lead", { wave: 1, bend: 1, sync: 1, fold: 1, drive: 1, wide: 1, attack: 0, release: 0.2 }),
        ...mapFilter({ cutoff: 0.85, resonance: 1 }),
      ],
    }], 120, 1024);
    for (const sample of hot) {
      assert.ok(Number.isFinite(sample));
      assert.ok(Math.abs(sample) < 4);
    }
  });

  it("leaves the mix alone when every bus knob is zero", () => {
    const events = [tone("bass", 40, 100), kick(1)];
    const plain = renderBlock(createEngine(), events, 120, 4000);
    const engine = createEngine();
    engine.bus = { glue: 0, pump: 0, wide: 0, tilt: 0 };
    const same = renderBlock(engine, events, 120, 4000);
    assert.deepEqual(same, plain);
  });

  it("packs the bus after the fx trailer", () => {
    const packed = packPhraseBody([], [], "1.0000", formatBus({ glue: 0, pump: 1, wide: 0.5, tilt: -0.25 }));
    assert.equal(packed, "@1.0000^0.0000,1.0000,0.5000,-0.2500");
  });

  it("ducks bass on a kick and lets it back across an eighth", () => {
    const events = [kick(1), tone("bass", 40, 110)];
    const dry = renderBus(0, "pump", events, 18000);
    const wet = renderBus(1, "pump", events, 18000);
    const early = diffEnergy(dry, wet, 200, 2000);
    const late = diffEnergy(dry, wet, 15000, 17000);
    assert.ok(early > late * 4);
    assert.ok(energy(wet, 200, 2000) < energy(dry, 200, 2000));
  });

  it("spreads chord tones by pitch and leaves the kick centered", () => {
    const low = renderBus(1, "wide", [tone("chords", 48, 120), tone("chords", 72, 24)], 3000);
    const high = renderBus(1, "wide", [tone("chords", 48, 24), tone("chords", 72, 120)], 3000);
    assert.ok(channelEnergy(low, 400, 2500, 0) > channelEnergy(low, 400, 2500, 1));
    assert.ok(channelEnergy(high, 400, 2500, 1) > channelEnergy(high, 400, 2500, 0));
    const dryKick = renderBlock(createEngine(), [kick(110)], 120, 2000);
    const wideKick = renderBus(1, "wide", [kick(110)], 2000);
    assert.deepEqual(wideKick, dryKick);
  });

  it("brightens a high note and darkens a low one", () => {
    const highUp = rms(renderBus(1, "tilt", [tone("lead", 96, 70)], 4000));
    const highDry = rms(renderBus(0, "tilt", [tone("lead", 96, 70)], 4000));
    const highDown = rms(renderBus(-1, "tilt", [tone("lead", 96, 70)], 4000));
    assert.ok(highUp > highDry);
    assert.ok(highDry > highDown);
    const lowUp = rms(renderBus(1, "tilt", [tone("bass", 36, 80)], 4000));
    const lowDown = rms(renderBus(-1, "tilt", [tone("bass", 36, 80)], 4000));
    assert.ok(lowDown > lowUp);
  });

  it("lowers the crest of a hit when glue is up", () => {
    const dry = crest(renderBus(0, "glue", [kick(120), tone("bass", 40, 90)], 8000));
    const glued = crest(renderBus(1, "glue", [kick(120), tone("bass", 40, 90)], 8000));
    assert.ok(glued < dry);
  });

  it("lets the decay macro lengthen a melodic release", () => {
    const project = defaultProject();
    const base = project.working.bass.sound.release.value;
    project.macros.decay = 0.4;
    const motion = soundMotions(project).find((item) => item.lane === "bass" && item.id === "release");
    assert.ok(motion);
    assert.ok(Math.abs(motion.value - Math.min(1, base + 0.4)) < 1e-6);
  });
});

function tone(lane: LaneId, note: number, velocity: number): BlockEvent {
  return {
    sampleOffset: 0,
    lane,
    note,
    velocity,
    lengthTicks: 800,
    params: [
      { id: "wave", value: 0 },
      { id: "cutoff", value: 0.5 },
      { id: "attack", value: 0 },
      { id: "release", value: 0.8 },
    ],
  };
}

function kick(velocity: number): BlockEvent {
  return {
    sampleOffset: 0,
    lane: "kick",
    note: 36,
    velocity,
    lengthTicks: 48,
    params: [
      { id: "freq", value: 0.4 },
      { id: "decay", value: 0.45 },
    ],
  };
}

function renderBus(amount: number, knob: "glue" | "pump" | "wide" | "tilt", events: BlockEvent[], frames: number): Float32Array {
  const engine = createEngine();
  engine.bus = { glue: 0, pump: 0, wide: 0, tilt: 0, [knob]: amount };
  engine.tempo = 120;
  return renderBlock(engine, events, 120, frames);
}

function energy(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    sum += buf[i * 2] * buf[i * 2] + buf[i * 2 + 1] * buf[i * 2 + 1];
  }
  return sum;
}

function channelEnergy(buf: Float32Array, from: number, to: number, channel: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const x = buf[i * 2 + channel];
    sum += x * x;
  }
  return sum;
}

function diffEnergy(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from * 2; i < to * 2; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function crest(buf: Float32Array): number {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    sum += buf[i] * buf[i];
  }
  return peak / Math.sqrt(sum / buf.length);
}

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
    params: mapSound("chords", { wave: 0.42, bend: 0, sync: 0, fold: 0, drive: 0, wide: width, cutoff: 0.9, resonance: 0.1, attack: 0, release: 0.8 }),
  }], 120);
  let diff = 0;
  for (let i = 0; i < 128; i++) diff += Math.abs(audio[i * 2] - audio[i * 2 + 1]);
  return diff;
}