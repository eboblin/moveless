import { SAMPLE_RATE } from "../core/clock.ts";
import { FX_DELAY, FX_REVERB, type Fx } from "../core/types.ts";

const SR = SAMPLE_RATE;
/** Dattorro published the plate at 29761 Hz. Delay lengths scale from there. */
const PAPER = SR / 29761;
/** Two grains on one line, about 46 ms. Zero does not write it. */
const SHIM_N = 2048;
const SHIM_POLE = 1 - Math.exp((-2 * Math.PI * 6000) / SR);
/** A hit slams the delay shut. It eases back over about 0.9 s, so the first repeat is still sitting down. */
const DUCK_RELEASE = Math.exp(-1 / (0.9 * SR));

interface Line {
  buf: Float32Array;
  i: number;
}

function makeLine(n: number): Line {
  return { buf: new Float32Array(n), i: 0 };
}

function read(line: Line, delay: number): number {
  const n = line.buf.length;
  let d = delay;
  if (d < 1) d = 1;
  const max = n - 2;
  if (d > max) d = max;
  let pos = line.i - d;
  while (pos < 0) pos += n;
  const i0 = Math.floor(pos) % n;
  const frac = pos - Math.floor(pos);
  const i1 = i0 + 1 === n ? 0 : i0 + 1;
  return line.buf[i0] * (1 - frac) + line.buf[i1] * frac;
}

function write(line: Line, x: number): void {
  if (x > -1e-15 && x < 1e-15) x = 0;
  line.buf[line.i] = x;
  if (++line.i >= line.buf.length) line.i = 0;
}

function ap(line: Line, delay: number, x: number, g: number): number {
  const z = read(line, delay);
  const y = -g * x + z;
  write(line, x + g * y);
  return y;
}

function delayed(line: Line, samples: number, x: number): number {
  const y = read(line, samples);
  write(line, x);
  return y;
}

const IN_AP = [142, 107, 379, 277];
const IN_GAIN = [0.75, 0.75, 0.625, 0.625];
const TANK = { modL: 672, dL1: 4453, apL: 1800, dL2: 3720, modR: 908, dR1: 4217, apR: 2656, dR2: 3163 };
/** Paper delays of one round trip, in seconds at the published rate. */
const LOOP_PAPER = (672 + 4453 + 1800 + 3720 + 908 + 4217 + 2656 + 3163) / 29761;
/** Seven taps would sit well above the dry hit. This parks LEVEL 0.7 beside it. */
const TAP_TRIM = 0.15;
/** Early cluster, fixed against the trimmed tail. */
const EARLY_TRIM = 0.4;
const HP = 1 - Math.exp((-2 * Math.PI * 40) / SR);

/** Seconds, then gain. Left and right keep the source's side. */
const EARLY_L: readonly (readonly [number, number])[] = [
  [0.0059, 0.42],
  [0.0112, -0.28],
  [0.0178, 0.18],
  [0.0294, -0.11],
];
const EARLY_R: readonly (readonly [number, number])[] = [
  [0.0074, 0.4],
  [0.0131, -0.26],
  [0.0236, 0.16],
  [0.037, -0.1],
];

function tankLen(base: number): number {
  return Math.ceil(base * PAPER * 1.85) + 32;
}

function unit(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Room scale 0.8…1.35. Predelay and early spacing come from the same scale. */
function roomOf(size: number): [number, number, number] {
  const u = unit(size);
  return roomFromScale(0.8 + u * 0.55);
}

function roomFromScale(scale: number): [number, number, number] {
  const u = (scale - 0.8) / 0.55;
  return [scale, (0.006 + u * 0.03) * SR, 0.7 + u * 0.6];
}

/**
 * Longest tank line, in samples per unit of scale. SIZE may move the read
 * by only a fraction of a sample each sample, or the tail clicks.
 */
const SCALE_SLEW = 0.25 / (4453 * PAPER);

function followScale(current: number, target: number): number {
  const d = target - current;
  if (d > SCALE_SLEW) return current + SCALE_SLEW;
  if (d < -SCALE_SLEW) return current - SCALE_SLEW;
  return target;
}

function sized(base: number, scale: number): number {
  return base * PAPER * scale;
}

/** DECAY 0 is 0.4 s, DECAY 1 is 60 s. One gain per side, so the round trip is gain². */
function decayGain(decay: number, scale: number): number {
  const seconds = 0.4 * 150 ** unit(decay);
  const loop = LOOP_PAPER * scale;
  const coef = Math.exp((Math.log(0.001) * loop) / (2 * seconds));
  return coef > 0.99 ? 0.99 : coef;
}

/** Input bandwidth and tank damping, Hz. Center is the natural plate. */
function airHz(air: number): [number, number] {
  const u = unit(air);
  const bw = u < 0.5 ? 2000 * 6 ** (u / 0.5) : 12000 * (4 / 3) ** ((u - 0.5) / 0.5);
  const damp = u < 0.5 ? 2000 * 3 ** (u / 0.5) : 6000 * (5 / 3) ** ((u - 0.5) / 0.5);
  return [bw, damp];
}

function pole(hz: number): number {
  const c = 1 - Math.exp((-2 * Math.PI * hz) / SR);
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/**
 * Rate in Hz and excursion in samples. Zero does not move.
 * Depth is capped by the shortest output tap so a small room cannot pinch it.
 * The top is a few hertz and well over a semitone: the tail itself swirls.
 */
function spinOf(spin: number, scale: number): [number, number] {
  const u = unit(spin);
  const room = Math.max(1, sized(121, scale) - 8);
  return [0.5 + u * 3, (u * 0.35 + u * u * 0.65) * room];
}

export interface Tank {
  preL: Line;
  preR: Line;
  earlyL: Line;
  earlyR: Line;
  inn: Line[];
  modL: Line;
  modR: Line;
  dL1: Line;
  dL2: Line;
  dR1: Line;
  dR2: Line;
  apL: Line;
  apR: Line;
  /** Octave grains, about 46 ms. Written only while SHIM is up. */
  shim: Line;
  shimPhase: number;
  shimLp: number;
  dampL: number;
  dampR: number;
  hpL: number;
  hpR: number;
  bw: number;
  right: number;
  lfo: number;
  /** Followed room scale. Zero means the next sample snaps to the knob. */
  scale: number;
  quiet: number;
}

export interface Echo {
  l: Line;
  r: Line;
  lpL: number;
  lpR: number;
  phase: number;
  /** How hard the last hit is still holding the delay down. Falls over about 0.9 s. */
  hold: number;
  /** Delay in samples the read is actually using. 0 snaps to the knob. */
  follow: number;
  quiet: number;
}

export function createTank(): Tank {
  return {
    preL: makeLine(Math.ceil(SR * 0.05) + 8),
    preR: makeLine(Math.ceil(SR * 0.05) + 8),
    earlyL: makeLine(Math.ceil(SR * 0.08) + 8),
    earlyR: makeLine(Math.ceil(SR * 0.08) + 8),
    inn: IN_AP.map((n) => makeLine(Math.ceil(n * PAPER) + 8)),
    modL: makeLine(tankLen(TANK.modL)),
    modR: makeLine(tankLen(TANK.modR)),
    dL1: makeLine(tankLen(TANK.dL1)),
    dL2: makeLine(tankLen(TANK.dL2)),
    dR1: makeLine(tankLen(TANK.dR1)),
    dR2: makeLine(tankLen(TANK.dR2)),
    apL: makeLine(tankLen(TANK.apL)),
    apR: makeLine(tankLen(TANK.apR)),
    shim: makeLine(SHIM_N + 8),
    shimPhase: 0,
    shimLp: 0,
    dampL: 0,
    dampR: 0,
    hpL: 0,
    hpR: 0,
    bw: 0,
    right: 0,
    lfo: 0,
    scale: 0,
    quiet: 0,
  };
}

export function createEcho(): Echo {
  const n = Math.ceil(SR * 2) + 8;
  return { l: makeLine(n), r: makeLine(n), lpL: 0, lpR: 0, phase: 0, hold: 0, follow: 0, quiet: 0 };
}

export function clearTank(tank: Tank): void {
  for (const line of [tank.preL, tank.preR, tank.earlyL, tank.earlyR, ...tank.inn, tank.modL, tank.modR, tank.dL1, tank.dL2, tank.dR1, tank.dR2, tank.apL, tank.apR, tank.shim]) {
    line.buf.fill(0);
    line.i = 0;
  }
  tank.dampL = 0;
  tank.dampR = 0;
  tank.hpL = 0;
  tank.hpR = 0;
  tank.bw = 0;
  tank.right = 0;
  tank.lfo = 0;
  tank.scale = 0;
  tank.shimPhase = 0;
  tank.shimLp = 0;
  tank.quiet = 0;
}

export function clearEcho(echo: Echo): void {
  echo.l.buf.fill(0);
  echo.r.buf.fill(0);
  echo.l.i = 0;
  echo.r.i = 0;
  echo.lpL = 0;
  echo.lpR = 0;
  echo.phase = 0;
  echo.hold = 0;
  echo.follow = 0;
  echo.quiet = 0;
}

function smooth(state: number, x: number, coef: number): number {
  return state + (x - state) * coef;
}

function cluster(line: Line, x: number, taps: readonly (readonly [number, number])[], scale: number): number {
  let y = 0;
  for (let i = 0; i < taps.length; i++) y += read(line, taps[i][0] * scale * SR) * taps[i][1];
  write(line, x);
  return y;
}

/** Raised cosine. A pair half a window apart sums to one. */
function raised(t: number): number {
  return 0.5 * (1 - Math.cos(Math.PI * 2 * t));
}

/**
 * Octave up, once. The delay falls by one sample per sample, so each head
 * reads twice as fast as the write. At amount 0 the line stays untouched.
 */
function shimmer(tank: Tank, x: number, amount: number): number {
  if (amount <= 0) return x;
  const n = SHIM_N;
  let p = tank.shimPhase;
  if (p >= n) p -= n;
  const q = p >= n / 2 ? p - n / 2 : p + n / 2;
  const pitched = read(tank.shim, n - p) * raised(p / n) + read(tank.shim, n - q) * raised(q / n);
  write(tank.shim, x);
  tank.shimPhase = p + 1;
  tank.shimLp = smooth(tank.shimLp, pitched, SHIM_POLE);
  return x * (1 - amount) + tank.shimLp * amount;
}

/** Plate. SIZE sets the room, DECAY the tail, AIR the top, SPIN the drift, SHIM the octave in the loop. */
export function tankSample(tank: Tank, knobs: Fx["reverb"], inL: number, inR: number): [number, number] {
  const energyIn = Math.abs(inL) + Math.abs(inR);
  const [target] = roomOf(knobs.size);
  tank.scale = tank.scale === 0 ? target : followScale(tank.scale, target);
  if (energyIn < 1e-7 && tank.quiet > SR / 2) return [0, 0];
  const [scale, preSamples, earlyScale] = roomFromScale(tank.scale);
  const preL = delayed(tank.preL, Math.max(1, preSamples), inL);
  const preR = delayed(tank.preR, Math.max(1, preSamples), inR);
  const earlyL = cluster(tank.earlyL, preL, EARLY_L, earlyScale);
  const earlyR = cluster(tank.earlyR, preR, EARLY_R, earlyScale);
  const [bwHz, dampHz] = airHz(knobs.air);
  tank.bw = smooth(tank.bw, (preL + preR) * 0.5, pole(bwHz));
  let x = tank.bw;
  for (let i = 0; i < IN_AP.length; i++) x = ap(tank.inn[i], IN_AP[i] * PAPER, x, IN_GAIN[i]);
  const decay = decayGain(knobs.decay, scale);
  const [rate, excursion] = spinOf(knobs.spin, scale);
  tank.lfo += (Math.PI * 2 * rate) / SR;
  if (tank.lfo > Math.PI * 2) tank.lfo -= Math.PI * 2;
  const wobble = Math.sin(tank.lfo) * excursion;
  const swirl = Math.cos(tank.lfo) * excursion;
  const dampCoef = pole(dampHz);
  let left = x + tank.right * decay;
  left = ap(tank.modL, sized(TANK.modL, scale) + wobble, left, 0.7);
  let body = delayed(tank.dL1, sized(TANK.dL1, scale) + wobble, left);
  tank.dampL = smooth(tank.dampL, body, dampCoef);
  tank.hpL = smooth(tank.hpL, tank.dampL, HP);
  body = tank.dampL - tank.hpL;
  left = ap(tank.apL, sized(TANK.apL, scale) + wobble, body, 0.5);
  const leftEnd = delayed(tank.dL2, sized(TANK.dL2, scale) + wobble, left);
  const fed = shimmer(tank, leftEnd, unit(knobs.shim) * 0.75);
  let right = x + fed * decay;
  right = ap(tank.modR, sized(TANK.modR, scale) + swirl, right, 0.7);
  body = delayed(tank.dR1, sized(TANK.dR1, scale) + swirl, right);
  tank.dampR = smooth(tank.dampR, body, dampCoef);
  tank.hpR = smooth(tank.hpR, tank.dampR, HP);
  body = tank.dampR - tank.hpR;
  right = ap(tank.apR, sized(TANK.apR, scale) + swirl, body, 0.5);
  tank.right = delayed(tank.dR2, sized(TANK.dR2, scale) + swirl, right);
  const tapsL = read(tank.dL1, sized(266, scale) + wobble)
    + read(tank.dL1, sized(2974, scale) + wobble)
    - read(tank.apL, sized(1913, scale) + wobble)
    + read(tank.dL2, sized(1996, scale) + wobble)
    - read(tank.dR1, sized(1990, scale) + swirl)
    - read(tank.apR, sized(187, scale) + swirl)
    - read(tank.dR2, sized(1066, scale) + swirl);
  const tapsR = read(tank.dR1, sized(353, scale) + swirl)
    + read(tank.dR1, sized(3627, scale) + swirl)
    - read(tank.apR, sized(1228, scale) + swirl)
    + read(tank.dR2, sized(2673, scale) + swirl)
    - read(tank.dL1, sized(2111, scale) + wobble)
    - read(tank.apL, sized(335, scale) + wobble)
    - read(tank.dL2, sized(121, scale) + wobble);
  const outL = (earlyL * EARLY_TRIM + tapsL * TAP_TRIM) * knobs.level;
  const outR = (earlyR * EARLY_TRIM + tapsR * TAP_TRIM) * knobs.level;
  tank.quiet = energyIn + Math.abs(outL) + Math.abs(outR) < 1e-6 ? tank.quiet + 1 : 0;
  return [outL, outR];
}

/** The read may move by only half a sample each sample, or the repeat clicks. */
const DELAY_SLEW = 0.5;

function followDelay(current: number, target: number): number {
  const d = target - current;
  if (d > DELAY_SLEW) return current + DELAY_SLEW;
  if (d < -DELAY_SLEW) return current - DELAY_SLEW;
  return target;
}

/** Stereo delay. TIME runs from a 32nd note to one bar, never longer than two seconds. */
export function echoSample(echo: Echo, knobs: Fx["delay"], beats: number, tempo: number, inL: number, inR: number): [number, number] {
  const energyIn = Math.abs(inL) + Math.abs(inR);
  if (energyIn < 1e-7 && echo.quiet > SR / 2) {
    echo.hold = 0;
    return [0, 0];
  }
  const bar = Math.max(1, beats);
  const clock = Math.max(0, Math.min(1, knobs.time));
  let seconds = 0.125 * (bar / 0.125) ** clock * 60 / Math.max(1, tempo);
  if (seconds > 2) seconds = 2;
  if (seconds < 0.001) seconds = 0.001;
  const base = seconds * SR;
  echo.follow = echo.follow === 0 ? base : followDelay(echo.follow, base);
  const wow = unit(knobs.wow);
  let driftL = 0;
  let driftR = 0;
  if (wow > 0) {
    echo.phase += (Math.PI * 2 * (0.5 + wow * 2.5)) / SR;
    if (echo.phase > Math.PI * 2) echo.phase -= Math.PI * 2;
    const depth = wow * 0.01 * SR;
    driftL = Math.sin(echo.phase) * depth;
    driftR = Math.cos(echo.phase) * depth;
  }
  const timeL = Math.max(1, echo.follow + driftL);
  const timeR = Math.max(1, echo.follow + driftR);
  const delL = read(echo.l, timeL);
  const delR = read(echo.r, timeR);
  const taps = extraTaps(echo, knobs.taps, timeL, timeR, tempo);
  const bounce = unit(knobs.ping);
  const mono = (inL + inR) * 0.5;
  const srcL = inL * (1 - bounce) + mono * bounce;
  const srcR = inR * (1 - bounce);
  const fbL = delL * (1 - bounce) + delR * bounce;
  const fbR = delR * (1 - bounce) + delL * bounce;
  const feed = knobs.feed * 0.92;
  write(echo.l, toneSample(echo, "l", srcL + fbL * feed, knobs.tone));
  write(echo.r, toneSample(echo, "r", srcR + fbR * feed, knobs.tone));
  const hit = Math.min(1, energyIn * 12);
  if (hit > echo.hold) echo.hold = hit;
  else echo.hold *= DUCK_RELEASE;
  const env = echo.hold > 1 ? 1 : echo.hold;
  const open = (1 - unit(knobs.duck) * env) * knobs.level;
  const outL = (delL + taps[0]) * open;
  const outR = (delR + taps[1]) * open;
  echo.quiet = energyIn + Math.abs(outL) + Math.abs(outR) < 1e-6 ? echo.quiet + 1 : 0;
  return [outL, outR];
}

/**
 * Up to three hits on the sixteenth grid, beside the main repeat.
 * They sit before it while there is room, and after it when TIME is too short.
 * The step stays a sixteenth, so the knob does not stretch with TIME.
 */
function extraTaps(echo: Echo, taps: number, timeL: number, timeR: number, tempo: number): [number, number] {
  const step = (60 / Math.max(1, tempo) / 4) * SR;
  let left = 0;
  let right = 0;
  for (let i = 0; i < 3; i++) {
    const gain = tapLevel(taps, i);
    if (gain <= 0) continue;
    const tap = (read(echo.l, tapPlace(timeL, step, i + 1)) + read(echo.r, tapPlace(timeR, step, i + 1))) * 0.5 * gain;
    if (i === 0) {
      left += tap * 0.65;
      right += tap;
    } else if (i === 1) {
      left += tap;
      right += tap * 0.65;
    } else {
      left += tap;
      right += tap;
    }
  }
  return [left, right];
}

function tapPlace(main: number, step: number, k: number): number {
  const minGap = Math.max(0.012 * SR, step * 0.4);
  const back = main - k * step;
  if (back >= minGap && main - back >= minGap) return back;
  return Math.max(1, main + k * step);
}

function tapLevel(taps: number, index: number): number {
  const u = unit(taps);
  const start = index / 3;
  const end = (index + 1) / 3;
  if (u <= start) return 0;
  if (u >= end) return 1;
  return (u - start) / (end - start);
}

/** Center is a wire. Left of it is a lowpass down to 400 Hz, right a highpass up to 2.5 kHz. */
function toneSample(echo: Echo, side: "l" | "r", x: number, tone: number): number {
  const u = unit(tone);
  if (u === 0.5) {
    if (side === "l") echo.lpL = x;
    else echo.lpR = x;
    return x;
  }
  const hp = u > 0.5;
  const hz = hp ? 80 * (2500 / 80) ** ((u - 0.5) / 0.5) : 400 * 35 ** (u / 0.5);
  const state = side === "l" ? echo.lpL : echo.lpR;
  const y = smooth(state, x, pole(hz));
  if (side === "l") echo.lpL = y;
  else echo.lpR = y;
  return hp ? x - y : y;
}

/** Six reverb knobs, eight delay knobs, then beats per bar, already mixed for this moment. */
export function formatFx(fx: Fx, beats: number): string {
  const nums = [
    ...FX_REVERB.map((key) => fx.reverb[key]),
    ...FX_DELAY.map((key) => fx.delay[key]),
    beats,
  ];
  return nums.map((n) => n.toFixed(4)).join(",");
}
