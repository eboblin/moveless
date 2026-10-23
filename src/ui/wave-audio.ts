import { PPQN, SAMPLE_RATE, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { heardFx, laneHeard } from "../core/journal.ts";
import { generatePhrase } from "../core/phrase.ts";
import { LANES, type LaneId, type Phrase, type Project } from "../core/types.ts";
import { createEngine, loadPhrase, placeClock, renderDryBlock, type Engine } from "../dsp/voice.ts";
import { phraseLoop, soundMotions, type LoopEvent } from "../dsp/schedule.ts";
import { WAVE_HOP, emptyWave, type WaveTape } from "./wave.ts";

let engine: Engine | null = null;
let bound: Project | null = null;
let boundStamp = "";
let tape: WaveTape = emptyWave();
let period = 0;
/** Next sample to render. The pass stays continuous so tails cross the block edge. */
let cursor = 0;
/** Where this pass began. After the end of the loop, the prefix before it is filled. */
let restart = 0;
let prefixEnd = 0;
let primed = false;
let phase: "idle" | "main" | "prefix" | "done" = "idle";

/** Drop the rendered tape. The next view starts from the phrase again. */
export function resetWaveform(): void {
  engine = null;
  bound = null;
  boundStamp = "";
  tape = emptyWave();
  period = 0;
  cursor = 0;
  restart = 0;
  prefixEnd = 0;
  primed = false;
  phase = "idle";
}

export function waveformTape(): WaveTape {
  return tape;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.floor(a));
  let y = Math.abs(Math.floor(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function lcm(a: number, b: number): number {
  if (a === 0) return b;
  if (b === 0) return a;
  return Math.floor(a / gcd(a, b)) * b;
}

/** One pass of the lane loops, in ticks, then samples. Capped at eight bars. */
function loopPeriod(project: Project, phrase: Phrase): number {
  const barTicks = Math.max(1, Math.round(project.global.bar)) * PPQN;
  let ticks = 0;
  for (const lane of LANES) {
    if (!laneHeard(project, lane)) continue;
    ticks = lcm(ticks, Math.max(1, phrase.steps[lane]) * SIXTEENTH_TICKS);
  }
  if (ticks <= 0) ticks = barTicks;
  const cap = barTicks * 8;
  if (ticks > cap) ticks = cap;
  return Math.max(WAVE_HOP, tickToSample(ticks, Math.max(1, project.global.tempo)));
}

const SKETCH_PAN: Record<LaneId, number> = {
  kick: 0,
  snare: -0.35,
  hat: 0.4,
  perc: 0.25,
  bass: -0.3,
  lead: 0.35,
  chords: 0.1,
};

function bump(map: Map<number, number>, key: number, value: number): void {
  const prev = map.get(key) ?? 0;
  if (value > prev) map.set(key, value);
}

/** How long this hit still occupies the strip. Drums decay; notes hold their length. */
function bodySamples(event: LoopEvent, tempo: number): number {
  const ms = (seconds: number) => Math.max(WAVE_HOP, Math.round(seconds * SAMPLE_RATE));
  if (event.lane === "kick") return ms(0.14);
  if (event.lane === "snare") return ms(0.2);
  if (event.lane === "hat") return ms(0.06);
  if (event.lane === "perc") return ms(0.1);
  return Math.max(ms(0.05), tickToSample(Math.max(1, event.lengthTicks), tempo));
}

/**
 * The whole loop as an envelope, with no audio render. The past can use it
 * on the first frame. Real hops replace it as they arrive.
 */
function buildSketch(project: Project, phrase: Phrase, period: number): WaveTape {
  const sketch = emptyWave(WAVE_HOP, period);
  const tempo = Math.max(1, project.global.tempo);
  for (const event of phraseLoop(project, phrase)) {
    const amp = Math.max(0, Math.min(1, event.velocity / 127));
    if (!(amp > 0)) continue;
    const loop = Math.max(1, event.loop);
    const span = bodySamples(event, tempo);
    const pan = SKETCH_PAN[event.lane] ?? 0;
    const leftGain = Math.sqrt((1 - pan) / 2);
    const rightGain = Math.sqrt((1 + pan) / 2);
    const drum = event.lane === "kick" || event.lane === "snare" || event.lane === "hat" || event.lane === "perc";
    const hops = Math.max(1, Math.ceil(span / WAVE_HOP));
    let at = ((event.sample % loop) + loop) % loop;
    while (at < period) {
      for (let i = 0; i < hops; i++) {
        const env = drum ? amp * Math.exp((-3 * i) / hops) : i >= hops - 1 ? amp * 0.4 : amp;
        const key = Math.floor(((at + i * WAVE_HOP) % period) / WAVE_HOP) * WAVE_HOP;
        bump(sketch.left, key, env * leftGain);
        bump(sketch.right, key, env * rightGain);
      }
      at += loop;
    }
  }
  return sketch;
}

/** Deck knobs are not part of this. Turning them must not rebuild the picture. */
function audioStamp(project: Project): string {
  const phrase = generatePhrase(project);
  return JSON.stringify([
    project.global.tempo,
    project.global.bar,
    project.global.seed,
    project.global.phrase,
    project.global.scale,
    project.global.swing,
    project.mixer,
    project.mute,
    project.solo,
    project.lock,
    project.bus,
    heardFx(project),
    phrase.steps,
    phraseLoop(project, phrase),
    soundMotions(project, phrase),
  ]);
}

function bind(project: Project): Engine {
  if (engine && bound === project) return engine;
  const stamp = audioStamp(project);
  if (engine && stamp === boundStamp) {
    bound = project;
    return engine;
  }
  const next = createEngine();
  next.fx = heardFx(project);
  next.bus = project.bus;
  next.beats = Math.max(1, project.global.bar);
  const phrase = generatePhrase(project);
  loadPhrase(next, phraseLoop(project, phrase), project.global.tempo, true, soundMotions(project, phrase));
  const nextPeriod = loopPeriod(project, phrase);
  const previous = tape.period === nextPeriod && tape.left.size > 0 ? tape : undefined;
  if (previous) previous.held = undefined;
  period = nextPeriod;
  tape = emptyWave(WAVE_HOP, period);
  tape.held = previous;
  tape.sketch = buildSketch(project, phrase, period);
  cursor = 0;
  restart = 0;
  prefixEnd = 0;
  primed = false;
  phase = "idle";
  engine = next;
  bound = project;
  boundStamp = stamp;
  return next;
}

/** Start at the left edge of the window so the past is the first audio drawn. */
function prime(voice: Engine, head: number, span: number): void {
  if (primed) return;
  primed = true;
  phase = "main";
  let start = 0;
  if (period > 0 && span > 0) {
    const left = head - span / 2;
    const wrapped = left % period;
    const folded = wrapped < 0 ? wrapped + period : wrapped;
    start = Math.floor(folded / WAVE_HOP) * WAVE_HOP;
  }
  cursor = start;
  restart = start;
  if (start > 0) placeClock(voice, start);
}

/** One continuous block. Seeking each hop would drop every tail and leave a spike. */
function renderAhead(voice: Engine): boolean {
  if (phase === "done" || phase === "idle" || !(period > 0)) return false;
  if (phase === "main" && cursor >= period) {
    if (restart > 0) {
      prefixEnd = restart;
      restart = 0;
      cursor = 0;
      phase = "prefix";
      placeClock(voice, 1);
    } else {
      phase = "done";
      return false;
    }
  }
  if (phase === "prefix" && cursor >= prefixEnd) {
    phase = "done";
    prefixEnd = 0;
    return false;
  }
  const room = phase === "prefix" ? prefixEnd - cursor : period - cursor;
  const frames = Math.min(WAVE_HOP, Math.max(0, room));
  if (frames <= 0) {
    phase = "done";
    return false;
  }
  const audio = renderDryBlock(voice, frames);
  const key = Math.floor(cursor / WAVE_HOP) * WAVE_HOP;
  let left = tape.left.get(key) ?? 0;
  let right = tape.right.get(key) ?? 0;
  for (let i = 0; i < frames; i++) {
    const l = Math.abs(audio[i * 2] ?? 0);
    const r = Math.abs(audio[i * 2 + 1] ?? 0);
    if (l > left) left = l;
    if (r > right) right = r;
  }
  tape.left.set(key, left);
  tape.right.set(key, right);
  cursor += frames;
  return true;
}

/** True once the whole loop is stored. Until then the past stays up and the future is borrowed. */
export function waveformCovers(_head = 0, _span = 0): boolean {
  return phase === "done";
}

/** Render the loop from the left edge of the window. A few blocks per call. */
export function serviceWaveform(project: Project, head = 0, span = 0, budgetMs = 8): WaveTape {
  const voice = bind(project);
  prime(voice, head, span);
  const started = Date.now();
  for (let n = 0; n < 24; n++) {
    if (!renderAhead(voice)) break;
    if (Date.now() - started >= budgetMs) break;
  }
  return tape;
}

/** Fill the loop. Tests and a cold screen use this; the host spreads the work. */
export function fillWaveform(project: Project, head = 0, span = 0): WaveTape {
  const voice = bind(project);
  prime(voice, head, span);
  const guard = Math.ceil(period / WAVE_HOP) + 4;
  for (let n = 0; n < guard; n++) {
    if (!renderAhead(voice)) break;
  }
  return tape;
}
