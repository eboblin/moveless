import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  barSamples,
  brakeSamples,
  deckSlots,
  deckPicture,
  deckRead,
  defaultDeck,
  divSamples,
  formatDeckCommand,
  lenSamples,
  lenUnit,
  parseDeckCommand,
  recallGroup,
  setGroupCell,
  assembleDeck,
  writeDeckKnob,
  type DeckMoment,
} from "../src/core/deck.ts";
import { commandDeck, createDeckRuntime, hearDeck } from "../src/dsp/deck.ts";
import { createEngine, renderClock } from "../src/dsp/voice.ts";

const TEMPO = 120;

function moment(patch: Partial<DeckMoment> & Pick<DeckMoment, "gesture" | "now">): DeckMoment {
  return {
    down: 0,
    up: null,
    tempo: TEMPO,
    barBeats: 4,
    knobs: defaultDeck(),
    ahead: 0,
    seed: 1,
    ...patch,
  };
}

describe("deck curves", () => {
  it("brakes to silence across the brake", () => {
    const knobs = defaultDeck();
    const span = brakeSamples(knobs, TEMPO);
    const read = deckRead(moment({ gesture: "stop", now: span, knobs }));
    assert.ok(read.rate < 0.02);
    assert.ok(read.gain < 0.05);
    const parked = deckPicture(moment({ gesture: "stop", now: span, knobs }));
    assert.equal(parked.gain, 1);
    const mid = deckRead(moment({ gesture: "stop", now: Math.floor(span / 4), knobs }));
    assert.ok(mid.rate < 0.8);
    assert.ok(mid.rate > 0.05);
    assert.equal(mid.live, 0);
  });

  it("spins up onto the live head at the downbeat", () => {
    const knobs = defaultDeck();
    const beat = (44100 * 60) / TEMPO;
    const bar = beat * 4;
    const down = Math.round(bar + beat);
    const minSpan = brakeSamples(knobs, TEMPO);
    let target = bar * 2;
    if (target - down < minSpan) target += bar;
    const read = deckRead(moment({ gesture: "spin", down, now: target - 1, knobs }));
    assert.ok(Math.abs(read.pos - target) < 8, `pos ${read.pos} target ${target}`);
    assert.ok(Math.abs(read.rate - 1) < 0.05, `rate ${read.rate}`);
    const landed = deckRead(moment({ gesture: "spin", down, now: target, knobs }));
    assert.equal(landed.live, 1);
    assert.equal(landed.pos, target);
  });

  it("repeats a slice whose period is the division", () => {
    const knobs = { ...defaultDeck(), quant: 0, div: 4 };
    const div = divSamples(knobs, TEMPO);
    const down = div * 4;
    const a = deckRead(moment({ gesture: "roll", down, now: down + 10, knobs }));
    const b = deckRead(moment({ gesture: "roll", down, now: down + 10 + div, knobs }));
    assert.equal(a.live, 0);
    assert.equal(a.pos, b.pos);
    assert.notEqual(a.pos, deckRead(moment({ gesture: "roll", down, now: down + 11, knobs })).pos);
  });

  it("finishes a reverse on the window boundary", () => {
    const knobs = { ...defaultDeck(), quant: 0, len: 0 };
    const len = lenSamples(knobs, TEMPO, 4);
    const down = len * 2;
    const last = down + len - 1;
    const future = deckRead(moment({ gesture: "rev", down, now: last, knobs, ahead: len }));
    assert.ok(Math.abs(future.pos - down) <= 1, `future pos ${future.pos}`);
    assert.equal(future.rate, -1);
    const done = deckRead(moment({ gesture: "rev", down, now: down + len, knobs, ahead: len }));
    assert.equal(done.live, 1);
    const past = deckRead(moment({ gesture: "rev", down, now: last, knobs, ahead: 0 }));
    assert.ok(Math.abs(past.pos - (down - len)) <= 1, `past pos ${past.pos}`);
  });

  it("keeps a bar of groove centered on the stylus", () => {
    const knobs = { ...defaultDeck(), quant: 0, div: 4 };
    const div = divSamples(knobs, TEMPO);
    const bar = barSamples(TEMPO, 4);
    const down = div * 4;
    const idle = deckPicture(moment({ gesture: null, now: down + 10 }));
    const a = deckPicture(moment({ gesture: "roll", down, now: down + 10, knobs }));
    const looped = deckPicture(moment({ gesture: "loop", down, now: down + 10, knobs }));
    const mid = deckPicture(moment({ gesture: "roll", down, now: down + 10 + Math.floor(div / 2), knobs }));
    const wrapped = deckPicture(moment({ gesture: "roll", down, now: down + 10 + div, knobs }));
    assert.equal(a.span, bar);
    assert.equal(idle.span, bar);
    assert.equal(looped.span, bar);
    assert.ok(Math.abs(a.start - (a.head - a.span / 2)) < 0.001);
    assert.ok(mid.head > a.head);
    assert.ok(Math.abs(mid.start - a.start - (mid.head - a.head)) < 0.001);
    assert.ok(Math.abs(wrapped.head - a.head) < 2);
    const dry = deckPicture(moment({ gesture: "roll", down, now: down + 10 + Math.floor(div / 2), knobs: { ...knobs, depth: 0 } }));
    assert.equal(dry.head, mid.head);
    assert.equal(dry.start, mid.start);
    const beat = (44100 * 60) / TEMPO;
    const early = deckPicture(moment({ gesture: "stop", down: beat, now: beat + 10 }));
    const later = deckPicture(moment({ gesture: "stop", down: beat, now: beat + Math.floor(beat / 4) }));
    const live = deckPicture(moment({ gesture: null, now: beat + Math.floor(beat / 4) }));
    assert.equal(later.span, live.span);
    assert.ok(later.head > early.head);
    assert.ok(later.head < live.head);
  });

  it("puts depth on the right and shows only the group's knobs", () => {
    const knobs = defaultDeck();
    assert.deepEqual(deckSlots("rpt", knobs), ["row", null, null, null, null, "div", "quant", "depth"]);
    assert.deepEqual(deckSlots("scr", knobs), ["row", "len", "vary", "duty", "ramp", "brake", "quant", "depth"]);
    assert.deepEqual(deckSlots("stp", knobs), ["row", null, null, null, null, "brake", null, "depth"]);
    assert.deepEqual(deckSlots("gat", knobs), ["row", "duty", null, null, null, "div", "quant", "depth"]);
    assert.deepEqual(deckSlots("pch", knobs), ["row", "ramp", null, null, null, "rate", "quant", "depth"]);
    assert.deepEqual(deckSlots("lop", { ...knobs, quant: 1 }), ["row", "div", null, null, null, "len", "quant", "depth"]);
    assert.deepEqual(deckSlots("thr", { ...knobs, quant: 1 }), ["row", null, null, null, null, "open", "quant", "depth"]);
    assert.deepEqual(deckSlots("scr", { ...knobs, quant: 1 }), ["row", "len", "vary", "duty", "ramp", "brake", "quant", "depth"]);
  });

  it("walks glitch slices in order and cuts a slot below half duty", () => {
    const knobs = assembleDeck({ ...defaultDeck(), len: 1, duty: 0.5, quant: 0 }, "glc", 4);
    const div = divSamples(knobs, TEMPO);
    const down = div * 8;
    const a = deckRead(moment({ gesture: "glc1", down, now: down + 10, knobs }));
    const b = deckRead(moment({ gesture: "glc1", down, now: down + div + 10, knobs }));
    assert.ok(Math.abs(b.pos - a.pos - div) < 2, `step ${b.pos - a.pos} div ${div}`);
    const lateAt = down + Math.floor(div * 0.75);
    const open = deckRead(moment({ gesture: "glc1", down, now: lateAt, knobs }));
    const gated = deckRead(moment({ gesture: "glc1", down, now: lateAt, knobs: { ...knobs, duty: 0.25 } }));
    assert.equal(open.gain, 1);
    assert.equal(gated.gain, 0);
    assert.equal(deckRead(moment({ gesture: "glc0", down, now: down + 10, knobs })).gain, 1);
    const frozenA = deckRead(moment({ gesture: "glc3", down, now: down + 10, knobs }));
    const frozenB = deckRead(moment({ gesture: "glc3", down, now: down + div + 10, knobs }));
    assert.ok(Math.abs(frozenB.pos - frozenA.pos) < 2);
  });

  it("throws a quarter of the scratch window on the factory column", () => {
    const knobs = assembleDeck({ ...defaultDeck(), quant: 0, ramp: 0.5, vary: 0 }, "scr", 4);
    const len = lenSamples(knobs, TEMPO, 4);
    const down = len * 2;
    const at = down + Math.floor(len / 4);
    const baby = deckRead(moment({ gesture: "scr0", down, now: at, knobs }));
    assert.ok(Math.abs(baby.pos - (down + 0.25 * len)) < len * 0.08, `pos ${baby.pos}`);
    const shorter = assembleDeck(setGroupCell({ ...defaultDeck(), quant: 0, ramp: 0.5, vary: 0 }, "scr", 0, 0, 4), "scr", 4);
    const small = deckRead(moment({ gesture: "scr0", down, now: at, knobs: shorter }));
    assert.ok(Math.abs(small.pos - down) < Math.abs(baby.pos - down));
    const back = deckRead(moment({ gesture: "scr0", down, now: at, knobs: { ...knobs, ramp: 0 } }));
    assert.ok(back.pos < down);
  });

  it("remembers a division column on each group", () => {
    let deck = setGroupCell(defaultDeck(), "glc", 1, 0, 4);
    deck = recallGroup(deck, "rpt", 4);
    deck = writeDeckKnob(deck, "div", 4, 4);
    assert.equal(deck.cells[0]?.x, 4);
    assert.equal(deck.cells[2]?.x, 1);
    const glitch = recallGroup(deck, "glc", 4);
    assert.equal(glitch.div, 1);
    const loop = recallGroup(glitch, "lop", 4);
    assert.equal(loop.div, 1);
    assert.ok(Math.abs(loop.len - lenUnit(3, 4)) < 1e-6);
    assert.equal(recallGroup(loop, "rpt", 4).div, 4);
    const pitched = writeDeckKnob(recallGroup(deck, "pch", 4), "rate", 5, 4);
    assert.equal(pitched.cells[5]?.x, 5);
    assert.equal(pitched.div, 4);
    const thrown = writeDeckKnob(recallGroup(pitched, "thr", 4), "open", 1, 4);
    assert.equal(thrown.cells[7]?.x, 1);
    assert.equal(thrown.div, 4);
    assert.equal(writeDeckKnob(recallGroup(thrown, "rpt", 4), "row", 3, 4).cells[0]?.y, 3);
  });

  it("round-trips the voice record", () => {
    const command = {
      gesture: "roll" as const,
      knobs: defaultDeck(),
      warm: true,
      seed: 7,
      barBeats: 4,
    };
    const parsed = parseDeckCommand(formatDeckCommand(command));
    assert.equal(parsed?.gesture, "roll");
    assert.equal(parsed?.warm, true);
    assert.equal(parsed?.knobs.div, command.knobs.div);
    assert.equal(parsed?.seed, 7);
  });
});

describe("deck audio", () => {
  it("repeats an impulse on the beat-repeat period", () => {
    const deck = createDeckRuntime();
    const knobs = { ...defaultDeck(), quant: 0, div: 4 };
    deck.knobs = knobs;
    const div = divSamples(knobs, TEMPO);
    const down = div * 4;
    const at = down - div + 5;
    deck.ringL[at & deck.mask] = 1;
    deck.ringR[at & deck.mask] = -1;
    deck.filled = at + 1;
    commandDeck(deck, "roll", down);
    const now = down + 5;
    const first = hearDeck(deck, now, TEMPO, 0, 0);
    const second = hearDeck(deck, now + div, TEMPO, 0, 0);
    assert.ok(Math.abs(first[0] - 1) < 1e-4, `first ${first[0]}`);
    assert.ok(Math.abs(second[0] - 1) < 1e-4, `second ${second[0]}`);
    assert.ok(Math.abs(first[1] + 1) < 1e-4);
  });

  it("silences the master at the end of a vinyl stop", () => {
    const deck = createDeckRuntime();
    const span = brakeSamples(deck.knobs, TEMPO);
    commandDeck(deck, "stop", 0);
    const heard = hearDeck(deck, span, TEMPO, 0.8, -0.4);
    assert.ok(Math.abs(heard[0]) < 0.05);
    assert.ok(Math.abs(heard[1]) < 0.05);
  });

  it("renders a bar of cushion while the deck screen is up", () => {
    const engine = createEngine();
    engine.tempo = TEMPO;
    engine.deck.warm = true;
    engine.deck.barBeats = 4;
    renderClock(engine, 128);
    assert.ok(engine.deck.lead >= 128);
    const before = engine.deck.lead;
    renderClock(engine, 128);
    assert.ok(engine.deck.lead > before);
  });
});
