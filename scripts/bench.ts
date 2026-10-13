import { defaultProject } from "../src/core/defaults.ts";
import { generatePhrase } from "../src/core/phrase.ts";
import { eventsInBlock } from "../src/dsp/schedule.ts";
import { createEngine, renderBlock } from "../src/dsp/voice.ts";

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
console.log(JSON.stringify({
  rounds,
  ms: Number(phraseMs.toFixed(2)),
  events,
  usPerPhrase: Number(((phraseMs * 1000) / rounds).toFixed(1)),
  audioMs: Number(audioMs.toFixed(2)),
  frames,
  usPerBlock: Number(((audioMs * 1000) / rounds).toFixed(1)),
}, null, 2));
