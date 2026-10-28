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
  samplesPerBeat,
  scratchRoll,
  parseDeckCommand,
  recallGroup,
  setGroupCell,
  assembleDeck,
  readDeckSlot,
  writeDeckKnob,
  type DeckMoment,
} from "../src/core/deck.ts";
import { setDeck } from "../src/core/journal.ts";
import { defaultProject } from "../src/core/defaults.ts";
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
    const div = divSamples(knobs, TEMPO);
    const chopped = Math.floor(div * 0.9);
    const transform = moment({ gesture: "tran", down: 0, now: chopped, knobs });
    const gate = moment({ gesture: "gat0", down: 0, now: chopped, knobs });
    const drop = moment({ gesture: "drop", now: chopped, knobs });
    const offbeat = moment({ gesture: "gat3", down: 0, now: Math.floor(div * 0.75), knobs });
    assert.equal(deckRead(transform).gain, 0);
    assert.equal(deckRead(gate).gain, 0);
    assert.equal(deckRead(drop).gain, 0);
    assert.equal(deckRead(moment({ gesture: "gat3", down: 0, now: 10, knobs })).gain, 0);
    assert.equal(deckRead(offbeat).gain, 1);
    assert.equal(deckPicture(transform).gain, 1);
    assert.equal(deckPicture(gate).gain, 1);
    assert.equal(deckPicture(drop).gain, 1);
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

  it("shuffles a bar onto the offbeat and mangled slices stay in time", () => {
    const knobs = assembleDeck({ ...defaultDeck(), quant: 0 }, "glc", 4);
    const slice = divSamples(knobs, TEMPO);
    const bar = barSamples(TEMPO, 4);
    const beat = bar / 4;
    const down = bar;
    const read = (gesture: "glc0" | "glc1" | "glc2" | "glc3" | "glch", at: number, extra = knobs) =>
      deckRead(moment({ gesture, down, now: down + at, knobs: extra, ahead: bar }));
    assert.deepEqual(deckSlots("glc", knobs), ["row", null, null, null, null, "div", "quant", "depth"]);
    const downbeat = read("glc0", 10);
    const and = read("glc0", slice);
    assert.equal(downbeat.gain, 1);
    assert.equal(downbeat.rate, 1);
    assert.equal(Math.round((downbeat.pos - down) / slice) % 2, 1);
    assert.equal(Math.round((and.pos - down) / slice) % 2, 0);
    assert.equal(and.pos - down, Math.round((and.pos - down) / slice) * slice);
    const later = read("glc0", 110);
    assert.equal(later.pos - downbeat.pos, 100);
    const grain = Math.floor(slice / 2);
    const stutter = read("glc0", beat);
    const again = read("glc0", beat + grain);
    assert.equal(stutter.pos, again.pos);
    assert.ok(stutter.rate === 0.5 || stutter.rate === 1 || stutter.rate === 2);
    const plain = read("glc0", beat + 20);
    const ignored = read("glc0", beat + 20, { ...knobs, len: 0, duty: 0.1, vary: 1, ramp: 0 });
    assert.equal(ignored.pos, plain.pos);
    assert.equal(ignored.rate, plain.rate);
    assert.equal(ignored.gain, 1);
    let octave = false;
    for (let slot = 0; slot < 8; slot++) {
      const hit = read("glc2", slot * slice);
      assert.equal(hit.gain, 1);
      assert.ok(hit.pos >= down && hit.pos < down + bar);
      assert.ok(hit.rate === 0.5 || hit.rate === 1 || hit.rate === 2);
      if (hit.rate !== 1) octave = true;
    }
    assert.equal(octave, true);
    const legacy = read("glch", slice + 4);
    const shuffle = read("glc0", slice + 4);
    assert.equal(legacy.pos, shuffle.pos);
    assert.equal(legacy.rate, shuffle.rate);
    const quarter = setGroupCell({ ...defaultDeck(), quant: 0 }, "glc", 3, 0, 4);
    const qSlice = divSamples(quarter, TEMPO);
    const slipped = deckRead(moment({ gesture: "glc0", down, now: down + beat / 2, knobs: quarter, ahead: bar }));
    const onGrid = deckRead(moment({ gesture: "glc0", down, now: down, knobs: quarter, ahead: bar }));
    assert.equal((slipped.pos - down) % qSlice, 0);
    assert.notEqual((onGrid.pos - down) % qSlice, 0);
  });

  it("rolls a new scratch from complexity, length and the press", () => {
    const sixteenth = Math.max(1, Math.round(samplesPerBeat(TEMPO) / 4));
    const lengths = [2, 4, 6, 8, 12, 16];
    const rows = ["scr0", "scr1", "scr2", "scr3"] as const;
    for (let x = 0; x < 6; x++) {
      for (let y = 0; y < 4; y++) {
        for (let press = 1; press <= 6; press++) {
          const notes = scratchRoll(x, y, 1, press);
          assert.equal(notes.reduce((sum, note) => sum + note.len, 0), lengths[x]);
          assert.ok(notes.every((note) => note.len >= 1 && note.len <= 3));
          assert.ok(new Set(notes.map((note) => note.type)).size <= y + 1);
          if (y < 2) assert.ok(notes.every((note) => note.sign === 1 && note.len <= 2));
        }
      }
    }
    const simple = new Set(Array.from({ length: 24 }, (_, i) => scratchRoll(1, 0, 1, i + 1)[0]?.type));
    assert.ok(simple.size >= 2);
    let mixed = false;
    let changed = false;
    let previous = "";
    for (let press = 1; press <= 24; press++) {
      const notes = scratchRoll(5, 3, 1, press);
      if (new Set(notes.map((note) => note.len)).size >= 2 && new Set(notes.map((note) => note.type)).size >= 2) mixed = true;
      const key = notes.map((note) => `${note.len}${note.type}${note.sign}`).join(",");
      if (previous && key !== previous) changed = true;
      previous = key;
    }
    assert.ok(mixed);
    assert.ok(changed);
    const down = sixteenth * 16;
    const read = (x: number, y: number, sixteenths: number, press: number, extra: Partial<ReturnType<typeof defaultDeck>> = {}) => {
      const knobs = assembleDeck(
        setGroupCell({ ...defaultDeck(), quant: 0, ramp: 0.5, duty: 0.5, vary: 0.25, len: 0.5, ...extra }, "scr", x, y, 4),
        "scr",
        4,
      );
      return deckRead(moment({
        gesture: rows[y] ?? "scr0",
        down,
        now: down + Math.round(sixteenth * sixteenths),
        knobs,
        ahead: sixteenth * 8,
        press,
      }));
    };
    let baby = 1;
    for (let press = 1; press <= 40; press++) {
      const first = scratchRoll(1, 0, 1, press)[0];
      if (first?.type === 0 && first.len === 2 && first.sign === 1) {
        baby = press;
        break;
      }
    }
    const push = read(1, 0, 0.5, baby);
    const back = read(1, 0, 1.8, baby);
    const peak = read(1, 0, 1, baby);
    assert.ok(push.pos > down);
    assert.equal(push.gain, 1);
    assert.ok(peak.pos > back.pos);
    assert.ok(back.gain < 0.4 && back.gain > 0.15, `return ${back.gain}`);
    assert.equal(read(1, 0, 1.8, baby, { duty: 0 }).gain, 1);
    assert.ok(Math.abs(read(1, 0, 0, baby).pos - down) < 2);
    assert.ok(Math.abs(read(1, 0, 0, baby, { len: 0 }).pos - (down - 4 * sixteenth)) < 2);
    assert.ok(read(1, 0, 0.5, baby, { ramp: 0 }).pos < down);
    assert.ok(read(1, 0, 1.7, baby, { ramp: 1 }).pos > read(1, 0, 1.7, baby).pos);
    const beat = read(1, 0, 4, 1).pos - read(1, 0, 0, 1).pos;
    const eighth = read(0, 0, 2, 1).pos - read(0, 0, 0, 1).pos;
    const bar = read(5, 3, 16, 3).pos - read(5, 3, 0, 3).pos;
    assert.ok(Math.abs(beat - 4 * sixteenth) < 3);
    assert.ok(Math.abs(eighth - 2 * sixteenth) < 3);
    assert.ok(Math.abs(bar - 16 * sixteenth) < 3);
    let heard = false;
    for (let press = 1; press < 12; press++) {
      if (Math.abs(read(5, 3, 1, press).pos - read(5, 3, 1, press + 1).pos) > sixteenth * 0.05) heard = true;
    }
    assert.ok(heard);
  });

  it("returns the same knobs when the slot is already there", () => {
    const deck = defaultDeck();
    assert.equal(writeDeckKnob(deck, "depth", deck.depth, 4), deck);
    const project = defaultProject();
    const value = readDeckSlot(project.deck, "depth");
    assert.equal(setDeck(project, "depth", value), project);
    const moved = setDeck(project, "depth", value === 0 ? 0.5 : 0);
    assert.notEqual(moved, project);
    assert.equal(setDeck(moved, "depth", readDeckSlot(moved.deck, "depth")), moved);
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
    assert.equal(parsed?.knobs.filter, 0.5);
    assert.equal(parsed?.seed, 7);
    const colored = {
      ...command,
      knobs: { ...defaultDeck(), filter: 0.8, resonance: 0.25, drive: 0.4, low: 0, mid: 0.5, high: 1 },
    };
    const again = parseDeckCommand(formatDeckCommand(colored));
    assert.equal(again?.knobs.filter, 0.8);
    assert.equal(again?.knobs.resonance, 0.25);
    assert.equal(again?.knobs.drive, 0.4);
    assert.equal(again?.knobs.low, 0);
    assert.equal(again?.knobs.high, 1);
    assert.equal(again?.knobs.div, defaultDeck().div);
    const old = parseDeckCommand("D|-|2,0.5000,1.0000,4,0.2500,2,0.5000,0.5000|0|1|4");
    assert.equal(old?.knobs.filter, 0.5);
    assert.equal(old?.knobs.resonance, 0);
    assert.equal(old?.knobs.low, 0.5);
    assert.equal(old?.knobs.div, 2);
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
