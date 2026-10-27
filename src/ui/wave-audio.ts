import { PPQN, SAMPLE_RATE, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { heardFx, laneHeard, sameHeard } from "../core/journal.ts";
import { generatePhrase } from "../core/phrase.ts";
import { LANES, type LaneId, type Phrase, type Project } from "../core/types.ts";
import { phraseLoop, soundMotions, type LoopEvent } from "../dsp/schedule.ts";
import {
  hatDecaySeconds,
  kickDecaySeconds,
  melodyLevel,
  melodyReleaseSeconds,
  melodySustain,
  percDecaySeconds,
  snareBodyDecaySeconds,
  snareNoiseDecaySeconds,
} from "../dsp/envelope.ts";
import { WAVE_HOP, emptyWave, type WaveTape } from "./wave.ts";

let bound: Project | null = null;
let boundStamp = "";
let tape: WaveTape = emptyWave();
/** Times the collage stamp ran. A deck-only project skips this. */
let stampPasses = 0;

/** Drop the collage. The next view builds it again from the phrase. */
export function resetWaveform(): void {
  bound = null;
  boundStamp = "";
  tape = emptyWave();
  stampPasses = 0;
}

/** How many times the heard-phrase stamp has been built since the last reset. */
export function waveformPasses(): number {
  return stampPasses;
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

function fold(sample: number, period: number): number {
  const wrapped = sample % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

function unit(event: LoopEvent, key: string, fallback: number): number {
  const found = event.params.find((param) => param.id === key || param.id.endsWith(`_${key}`));
  if (!found) return fallback;
  return Math.max(0, Math.min(1, found.value));
}

function gains(lane: LaneId): [number, number] {
  const pan = SKETCH_PAN[lane] ?? 0;
  return [Math.sqrt((1 - pan) / 2), Math.sqrt((1 + pan) / 2)];
}

/** Exponential tail, the same shape as envK: exp(-t / bodySec). */
function paintDecay(tape: WaveTape, period: number, at: number, amp: number, seconds: number, leftGain: number, rightGain: number): void {
  if (!(amp > 0) || !(seconds > 0) || !(period > 0)) return;
  const tau = Math.max(1, seconds * SAMPLE_RATE);
  const hops = Math.max(1, Math.ceil((seconds * 4 * SAMPLE_RATE) / WAVE_HOP));
  for (let i = 0; i < hops; i++) {
    const env = amp * Math.exp((-i * WAVE_HOP) / tau);
    if (i > 0 && env < amp * 0.02) break;
    const key = Math.floor(fold(at + i * WAVE_HOP, period) / WAVE_HOP) * WAVE_HOP;
    bump(tape.left, key, env * leftGain);
    bump(tape.right, key, env * rightGain);
  }
}

/** The same gate shape the voice plays. Attack is a fraction of the note, sustain is the level at the end. */
function paintNote(
  tape: WaveTape,
  period: number,
  at: number,
  amp: number,
  gate: number,
  attack: number,
  sustain: number,
  releaseSec: number,
  leftGain: number,
  rightGain: number,
): void {
  if (!(amp > 0) || !(period > 0)) return;
  const hops = Math.max(1, Math.ceil((Math.max(1, gate) + releaseSec * 4 * SAMPLE_RATE) / WAVE_HOP));
  for (let i = 0; i < hops; i++) {
    const t = i * WAVE_HOP;
    const env = amp * melodyLevel(t, gate, attack, sustain, releaseSec);
    if (t >= gate && env < amp * 0.02) break;
    const key = Math.floor(fold(at + t, period) / WAVE_HOP) * WAVE_HOP;
    bump(tape.left, key, env * leftGain);
    bump(tape.right, key, env * rightGain);
  }
}

function paintHit(tape: WaveTape, period: number, event: LoopEvent, at: number, amp: number, tempo: number): void {
  const [leftGain, rightGain] = gains(event.lane);
  if (event.lane === "kick") {
    paintDecay(tape, period, at, amp, kickDecaySeconds(unit(event, "decay", 0.4)), leftGain, rightGain);
    return;
  }
  if (event.lane === "snare") {
    paintDecay(tape, period, at, amp, snareBodyDecaySeconds(unit(event, "bdcy", 0.3)), leftGain, rightGain);
    paintDecay(tape, period, at, amp, snareNoiseDecaySeconds(unit(event, "ndcy", 0.3)), leftGain, rightGain);
    const snap = unit(event, "snap", 0.4);
    const clickSamples = 40 + (1 - snap) ** 1.4 * 700;
    paintDecay(tape, period, at, amp, clickSamples / SAMPLE_RATE, leftGain, rightGain);
    return;
  }
  if (event.lane === "hat") {
    const body = hatDecaySeconds(unit(event, "decay", 0.3)) * (1 + unit(event, "ring", 0.3) * 2.8);
    paintDecay(tape, period, at, amp, body, leftGain, rightGain);
    return;
  }
  if (event.lane === "perc") {
    paintDecay(tape, period, at, amp, percDecaySeconds(unit(event, "decay", 0.4)), leftGain, rightGain);
    return;
  }
  const release = unit(event, "release", unit(event, "decay", 0.4));
  const hold = tickToSample(Math.max(1, event.lengthTicks), tempo);
  paintNote(tape, period, at, amp, hold, unit(event, "attack", 0), melodySustain(event.params), melodyReleaseSeconds(release), leftGain, rightGain);
}

/**
 * The whole loop as envelopes. One pass over the phrase, no voice.
 * Drum tails use the same seconds as the sounding voice. Notes use the same gate shape.
 */
function buildSketch(project: Project, phrase: Phrase, period: number): WaveTape {
  const sketch = emptyWave(WAVE_HOP, period);
  const tempo = Math.max(1, project.global.tempo);
  for (const event of phraseLoop(project, phrase)) {
    const amp = Math.max(0, Math.min(1, event.velocity / 127));
    if (!(amp > 0)) continue;
    const loop = Math.max(1, event.loop);
    let at = ((event.sample % loop) + loop) % loop;
    while (at < period) {
      paintHit(sketch, period, event, at, amp, tempo);
      at += loop;
    }
  }
  return sketch;
}

/** Deck knobs are not part of this. Turning them must not rebuild the picture. */
function audioStamp(project: Project, phrase: Phrase): string {
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

/**
 * Rebuild the collage when the heard phrase changes. Ring peaks stay on the tape the host fills.
 * A running morph keeps the picture already drawn: rebuilding it on every lane step stalls the strip.
 */
export function serviceWaveform(project: Project): WaveTape {
  if (bound === project) return tape;
  if (project.morph && bound) return tape;
  if (bound && sameHeard(bound, project)) {
    bound = project;
    return tape;
  }
  stampPasses += 1;
  const phrase = generatePhrase(project);
  const stamp = audioStamp(project, phrase);
  if (stamp === boundStamp) {
    bound = project;
    return tape;
  }
  tape = buildSketch(project, phrase, loopPeriod(project, phrase));
  bound = project;
  boundStamp = stamp;
  return tape;
}
