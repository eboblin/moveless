import { defaultProject } from "../src/core/defaults.ts";
import { generatePhrase } from "../src/core/phrase.ts";
import { eventsInBlock, phraseLoop } from "../src/dsp/schedule.ts";
import { createEngine, loadPhrase, renderBlock, renderClock } from "../src/dsp/voice.ts";

const project = defaultProject();
const rounds = 200;
const start = performance.now();
let events = 0;
for (let i = 0; i < rounds; i++) {
  const phrase = generatePhrase(project);
  for (const lane of Object.values(phrase.lanes)) events += lane.length;
}
const phraseMs = performance.now() - start;

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

console.log(JSON.stringify({
  rounds,
  ms: Number(phraseMs.toFixed(2)),
  events,
  usPerPhrase: Number(((phraseMs * 1000) / rounds).toFixed(1)),
  audioMs: Number(audioMs.toFixed(2)),
  frames,
  usPerBlock: Number(((audioMs * 1000) / rounds).toFixed(1)),
  deckUs: Number(((deckMs * 1000) / rounds).toFixed(1)),
  deckLead: deckEngine.deck.lead,
}, null, 2));
