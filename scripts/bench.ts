import { defaultProject } from "../src/core/defaults.ts";
import { punch } from "../src/core/morph.ts";
import { generatePhrase } from "../src/core/phrase.ts";
import { eventsInBlock, phraseLoop, soundMotions } from "../src/dsp/schedule.ts";
import { packPhraseBody, createEngine, loadPhrase, renderBlock, renderClock } from "../src/dsp/voice.ts";
import { renderScreen, WIDTH, HEIGHT } from "../src/ui/screen.ts";
import { defaultUi } from "../src/ui/state.ts";
import type { Project } from "../src/core/types.ts";

const project = defaultProject();
const rounds = 80;

function voiceProject(): Project {
  let next = defaultProject();
  next = punch(next, "snare.ratchet.count.pattern", -1);
  next = punch(next, "snare.ratchet.count.amount", 1);
  next = punch(next, "snare.ratchet.rate.pattern", -1);
  next = punch(next, "snare.ratchet.rate.amount", 0.8);
  next = punch(next, "hat.ratchet.count.pattern", -2);
  next = punch(next, "hat.ratchet.count.amount", 1);
  next = punch(next, "bass.repeat.pattern", -1);
  next = punch(next, "bass.repeat.amount", 1);
  return next;
}

const start = performance.now();
let events = 0;
for (let i = 0; i < rounds; i++) {
  const phrase = generatePhrase(project);
  for (const lane of Object.values(phrase.lanes)) events += lane.length;
}
const phraseMs = performance.now() - start;

const voiced = voiceProject();
let voiceEvents = 0;
const voiceStart = performance.now();
for (let i = 0; i < rounds; i++) {
  const view = { ...voiced, macros: { ...voiced.macros } };
  const phrase = generatePhrase(view);
  voiceEvents += phrase.lanes.snare.length + phrase.lanes.hat.length + phrase.lanes.bass.length;
}
const voiceMs = performance.now() - voiceStart;

let cold = voiced;
let coldEvents = 0;
const coldStart = performance.now();
for (let i = 0; i < rounds; i++) {
  cold = punch(cold, "snare.ratchet.count.amount", (i % 20) / 20);
  const phrase = generatePhrase(cold);
  coldEvents += phrase.lanes.snare.length;
}
const coldMs = performance.now() - coldStart;

const packed = cold;
const packPhrase = generatePhrase(packed);
const packStart = performance.now();
let packBytes = 0;
for (let i = 0; i < rounds; i++) {
  const body = packPhraseBody(phraseLoop(packed, packPhrase), soundMotions(packed, packPhrase));
  packBytes += body.length;
}
const packMs = performance.now() - packStart;

const ui = defaultUi();
const pixels = new Uint8Array(WIDTH * HEIGHT);
const screenStart = performance.now();
let lit = 0;
for (let i = 0; i < rounds; i++) renderScreen(voiced, ui, i * 48, true, 0, pixels);
for (let i = 0; i < pixels.length; i++) if (pixels[i]) lit++;
const screenMs = performance.now() - screenStart;

const engine = createEngine();
const audioStart = performance.now();
let frames = 0;
let tick = 0;
const samplesPerTick = (44100 * 60) / (project.global.tempo * 192);
for (let i = 0; i < rounds; i++) {
  const block = eventsInBlock(project, tick);
  frames += renderBlock(engine, block, project.global.tempo).length / 2;
  tick += 128 / samplesPerTick;
}
const audioMs = performance.now() - audioStart;

const deckEngine = createEngine();
loadPhrase(deckEngine, phraseLoop(project, generatePhrase(project)), project.global.tempo, true);
for (let i = 0; i < 16; i++) renderClock(deckEngine);
deckEngine.deck.warm = true;
deckEngine.deck.barBeats = project.global.bar;
let held = -1;
for (let i = 0; i < 4000 && deckEngine.deck.lead !== held; i++) {
  held = deckEngine.deck.lead;
  renderClock(deckEngine);
}
const deckStart = performance.now();
for (let i = 0; i < rounds; i++) renderClock(deckEngine);
const deckMs = performance.now() - deckStart;

const per = (ms: number) => Number(((ms * 1000) / rounds).toFixed(1));

console.log(JSON.stringify({
  rounds,
  ms: Number(phraseMs.toFixed(2)),
  events,
  usPerPhrase: per(phraseMs),
  voiceMs: Number(voiceMs.toFixed(2)),
  voiceEvents,
  usPerVoice: per(voiceMs),
  coldMs: Number(coldMs.toFixed(2)),
  coldEvents,
  usPerCold: per(coldMs),
  packMs: Number(packMs.toFixed(2)),
  packBytes,
  usPerPack: per(packMs),
  screenMs: Number(screenMs.toFixed(2)),
  usPerScreen: per(screenMs),
  lit,
  audioMs: Number(audioMs.toFixed(2)),
  frames,
  usPerBlock: per(audioMs),
  deckUs: per(deckMs),
  deckLead: deckEngine.deck.lead,
}, null, 2));
