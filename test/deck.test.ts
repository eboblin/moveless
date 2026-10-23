import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  barSamples,
  brakeSamples,
  deckKnobsFor,
  deckPicture,
  deckRead,
  defaultDeck,
  divSamples,
  formatDeckCommand,
  lenSamples,
  parseDeckCommand,
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

  it("names the knobs a gesture can change", () => {
    const knobs = defaultDeck();
    assert.deepEqual(deckKnobsFor("roll", knobs), ["div", "depth", "quant"]);
    assert.deepEqual(deckKnobsFor("scr", knobs), ["len", "shape", "depth", "quant"]);
    assert.deepEqual(deckKnobsFor("stop", knobs), ["brake", "depth"]);
    assert.deepEqual(deckKnobsFor("tran", knobs), ["div", "duty", "depth", "quant"]);
    assert.deepEqual(deckKnobsFor("hlx", knobs), ["div", "ramp", "depth", "quant"]);
    assert.equal(deckKnobsFor(null, knobs), null);
    assert.deepEqual(deckKnobsFor("drop", { ...knobs, quant: 1 }), ["depth", "quant", "div"]);
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
