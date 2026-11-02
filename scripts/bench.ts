import { SIXTEENTH_TICKS } from "../src/core/clock.ts";
import { clone } from "../src/core/clone.ts";
import { defaultProject } from "../src/core/defaults.ts";
import { launchScene, record } from "../src/core/journal.ts";
import { applyMorph, punch } from "../src/core/morph.ts";
import { generatePhrase } from "../src/core/phrase.ts";
import { LANES, type Project } from "../src/core/types.ts";
import { eventsInBlock, phraseLoop, soundMotions } from "../src/dsp/schedule.ts";
import { packPhraseBody, createEngine, loadPhrase, parseMeterPage, renderBlock, renderClock } from "../src/dsp/voice.ts";
import { laneMark, renderScreen, WIDTH, HEIGHT } from "../src/ui/screen.ts";
import { defaultUi } from "../src/ui/state.ts";
import { emptyWave, strokeWaveform } from "../src/ui/wave.ts";

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

generatePhrase(project);
const hitStart = performance.now();
let hitEvents = 0;
for (let i = 0; i < rounds; i++) hitEvents += generatePhrase(project).lanes.kick.length;
const hitMs = performance.now() - hitStart;

const tape = emptyWave();
for (let i = 0; i < 256; i++) {
  tape.left.set(i * 128, (i % 7) / 7);
  tape.right.set(i * 128, (i % 5) / 7);
}
let waveRects = 0;
const waveStart = performance.now();
for (let i = 0; i < rounds; i++) {
  strokeWaveform(
    tape,
    { x: 0, y: 0, w: WIDTH, h: 40, head: i * 128, span: 128 * 128, stylus: true },
    () => { waveRects += 1; },
    () => {},
  );
}
const waveMs = performance.now() - waveStart;

let punched = defaultProject();
const punchStart = performance.now();
for (let i = 0; i < rounds; i++) punched = punch(punched, "snare.ratchet.count.amount", (i % 20) / 20);
const punchMs = performance.now() - punchStart;

const mixUi = { ...ui, face: "mixer" as const };
let mixLit = 0;
const mixStart = performance.now();
for (let i = 0; i < rounds; i++) {
  const level = (i * 17) & 255;
  const byte = level.toString(16).padStart(2, "0");
  const screen = renderScreen(project, mixUi, 0, false, 0, pixels, 0, null, parseMeterPage((byte + byte).repeat(8)));
  mixLit += screen.pixels[0] ?? 0;
}
const mixMs = performance.now() - mixStart;

function morphProject(): Project {
  let next = defaultProject();
  next.transition = "medium";
  next = punch(next, "kick.gen1.velocity.value", 0.2);
  next = punch(next, "bass.filter.cutoff.value", 0.2);
  next = punch(next, "lead.pitch.value", 0.3);
  next = record(next);
  next = punch(next, "kick.gen1.velocity.value", 0.9);
  next = punch(next, "bass.filter.cutoff.value", 0.8);
  next = punch(next, "lead.pitch.value", 0.7);
  next = record(next);
  next = { ...next, working: clone(next.journal[0].lanes) };
  return launchScene(next, "002", 0);
}

let morphCursor = morphProject();
const morphSteps = Math.max(1, Math.ceil((morphCursor.morph?.durationTicks ?? 0) / SIXTEENTH_TICKS));
let morphRebuilds = 0;
let morphScreens = 0;
let morphMarks = 0;
let morphPhrase: ReturnType<typeof generatePhrase> | null = null;
const morphStart = performance.now();
for (let i = 0; i <= morphSteps; i++) {
  const at = i * SIXTEENTH_TICKS;
  morphCursor = applyMorph(morphCursor, at);
  const phrase = generatePhrase(morphCursor);
  if (phrase !== morphPhrase) morphRebuilds += 1;
  morphPhrase = phrase;
  for (const lane of LANES) morphMarks += laneMark(morphCursor, phrase, lane, at / SIXTEENTH_TICKS);
  renderScreen(morphCursor, ui, at, true, 0, pixels);
  morphScreens += 1;
}
const morphMs = performance.now() - morphStart;

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
  hitMs: Number(hitMs.toFixed(2)),
  hitEvents,
  usPerPhraseHit: per(hitMs),
  waveMs: Number(waveMs.toFixed(2)),
  waveRects,
  usPerWave: per(waveMs),
  punchMs: Number(punchMs.toFixed(2)),
  usPerPunch: per(punchMs),
  mixMs: Number(mixMs.toFixed(2)),
  mixLit,
  usPerMixer: per(mixMs),
  morphMs: Number(morphMs.toFixed(2)),
  morphSteps,
  morphRebuilds,
  morphScreens,
  morphMarks,
  usPerMorphStep: Number(((morphMs * 1000) / morphSteps).toFixed(1)),
}, null, 2));
