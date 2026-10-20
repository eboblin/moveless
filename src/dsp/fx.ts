import { SAMPLE_RATE } from "../core/clock.ts";
import { FX_DELAY, FX_REVERB, type Fx } from "../core/types.ts";

const SR = SAMPLE_RATE;
/** Dattorro published the plate at 29761 Hz. Delay lengths scale from there. */
const PAPER = SR / 29761;

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
const TANK = { modL: 672, dL1: 4453, apL: 1800, dL2: 3720, modR: 908, dR1: 4217, apR: 2656, dR2: 3163 };

function tankLen(base: number): number {
  return Math.ceil(base * PAPER * 1.85) + 32;
}

function sized(base: number, size: number): number {
  return base * PAPER * (0.5 + size * 1.3);
}

export interface Tank {
  pre: Line;
  inn: Line[];
  modL: Line;
  modR: Line;
  dL1: Line;
  dL2: Line;
  dR1: Line;
  dR2: Line;
  apL: Line;
  apR: Line;
  dampL: number;
  dampR: number;
  lowL: number;
  lowR: number;
  right: number;
  lfo: number;
  quiet: number;
}

export interface Echo {
  l: Line;
  r: Line;
  lpL: number;
  lpR: number;
  hpL: number;
  hpR: number;
  phase: number;
  quiet: number;
}

export function createTank(): Tank {
  return {
    pre: makeLine(Math.ceil(SR * 0.2) + 8),
    inn: IN_AP.map((n) => makeLine(Math.ceil(n * PAPER) + 8)),
    modL: makeLine(tankLen(TANK.modL)),
    modR: makeLine(tankLen(TANK.modR)),
    dL1: makeLine(tankLen(TANK.dL1)),
    dL2: makeLine(tankLen(TANK.dL2)),
    dR1: makeLine(tankLen(TANK.dR1)),
    dR2: makeLine(tankLen(TANK.dR2)),
    apL: makeLine(tankLen(TANK.apL)),
    apR: makeLine(tankLen(TANK.apR)),
    dampL: 0,
    dampR: 0,
    lowL: 0,
    lowR: 0,
    right: 0,
    lfo: 0,
    quiet: 0,
  };
}

export function createEcho(): Echo {
  const n = Math.ceil(SR * 2) + 8;
  return { l: makeLine(n), r: makeLine(n), lpL: 0, lpR: 0, hpL: 0, hpR: 0, phase: 0, quiet: 0 };
}

export function clearTank(tank: Tank): void {
  for (const line of [tank.pre, ...tank.inn, tank.modL, tank.modR, tank.dL1, tank.dL2, tank.dR1, tank.dR2, tank.apL, tank.apR]) {
    line.buf.fill(0);
    line.i = 0;
  }
  tank.dampL = 0;
  tank.dampR = 0;
  tank.lowL = 0;
  tank.lowR = 0;
  tank.right = 0;
  tank.lfo = 0;
  tank.quiet = 0;
}

export function clearEcho(echo: Echo): void {
  echo.l.buf.fill(0);
  echo.r.buf.fill(0);
  echo.l.i = 0;
  echo.r.i = 0;
  echo.lpL = 0;
  echo.lpR = 0;
  echo.hpL = 0;
  echo.hpR = 0;
  echo.phase = 0;
  echo.quiet = 0;
}

function smooth(state: number, x: number, coef: number): number {
  return state + (x - state) * coef;
}

/** Plate. SIZE stretches the tank. DECAY is the crossfeed. DAMP darkens it, LOW thins the bottom. */
export function tankSample(tank: Tank, knobs: Fx["reverb"], inL: number, inR: number): [number, number] {
  const energyIn = Math.abs(inL) + Math.abs(inR);
  if (energyIn < 1e-7 && tank.quiet > SR / 2) return [0, 0];
  const pre = delayed(tank.pre, Math.max(1, knobs.pre * 0.2 * SR), (inL + inR) * 0.5);
  const diffuse = 0.25 + knobs.diff * 0.5;
  let x = pre;
  for (let i = 0; i < IN_AP.length; i++) x = ap(tank.inn[i], IN_AP[i] * PAPER, x, diffuse);
  const decay = 0.25 + knobs.decay * 0.7;
  tank.lfo += (Math.PI * 1.6) / SR;
  if (tank.lfo > Math.PI * 2) tank.lfo -= Math.PI * 2;
  const wobble = Math.sin(tank.lfo) * 12 * PAPER;
  let left = x + tank.right * decay;
  left = ap(tank.modL, sized(TANK.modL, knobs.size) + wobble, left, 0.7);
  let body = delayed(tank.dL1, sized(TANK.dL1, knobs.size), left);
  tank.dampL = smooth(tank.dampL, body, 0.8 - knobs.damp * 0.75);
  tank.lowL = smooth(tank.lowL, tank.dampL, 0.002 + knobs.low * 0.03);
  body = (tank.dampL * (1 - knobs.low) + (tank.dampL - tank.lowL) * knobs.low) * decay;
  left = ap(tank.apL, sized(TANK.apL, knobs.size), body, 0.5);
  const leftLast = delayed(tank.dL2, sized(TANK.dL2, knobs.size), left);
  let right = x + leftLast * decay;
  right = ap(tank.modR, sized(TANK.modR, knobs.size) - wobble, right, 0.7);
  body = delayed(tank.dR1, sized(TANK.dR1, knobs.size), right);
  tank.dampR = smooth(tank.dampR, body, 0.8 - knobs.damp * 0.75);
  tank.lowR = smooth(tank.lowR, tank.dampR, 0.002 + knobs.low * 0.03);
  body = (tank.dampR * (1 - knobs.low) + (tank.dampR - tank.lowR) * knobs.low) * decay;
  right = ap(tank.apR, sized(TANK.apR, knobs.size), body, 0.5);
  tank.right = delayed(tank.dR2, sized(TANK.dR2, knobs.size), right);
  const mid = (leftLast + tank.right) * 0.5;
  const side = (leftLast - tank.right) * 0.5 * knobs.width;
  const outL = (mid + side) * knobs.level;
  const outR = (mid - side) * knobs.level;
  tank.quiet = energyIn + Math.abs(outL) + Math.abs(outR) < 1e-6 ? tank.quiet + 1 : 0;
  return [outL, outR];
}

/** Stereo delay. TIME runs from a 32nd note to one bar, never longer than two seconds. */
export function echoSample(echo: Echo, knobs: Fx["delay"], beats: number, tempo: number, inL: number, inR: number): [number, number] {
  const energyIn = Math.abs(inL) + Math.abs(inR);
  if (energyIn < 1e-7 && echo.quiet > SR / 2) return [0, 0];
  const bar = Math.max(1, beats);
  const unit = Math.max(0, Math.min(1, knobs.time));
  let seconds = 0.125 * (bar / 0.125) ** unit * 60 / Math.max(1, tempo);
  if (seconds > 2) seconds = 2;
  if (seconds < 0.001) seconds = 0.001;
  echo.phase += (Math.PI * 2 * (0.05 + knobs.rate * 4)) / SR;
  if (echo.phase > Math.PI * 2) echo.phase -= Math.PI * 2;
  const samples = seconds * SR + Math.sin(echo.phase) * knobs.mod * 0.008 * SR;
  const stereo = Math.min(1, knobs.width * 2);
  const ping = Math.max(0, knobs.width * 2 - 1);
  const mono = (inL + inR) * 0.5;
  const srcL = mono * (1 - stereo) + inL * stereo;
  const srcR = mono * (1 - stereo) + inR * stereo;
  const delL = read(echo.l, samples);
  const delR = read(echo.r, samples);
  const feed = knobs.feed * 0.92;
  write(echo.l, srcL + color(echo, "l", (delL * (1 - ping) + delR * ping) * feed, knobs));
  write(echo.r, srcR + color(echo, "r", (delR * (1 - ping) + delL * ping) * feed, knobs));
  const outL = delL * knobs.level;
  const outR = delR * knobs.level;
  echo.quiet = energyIn + Math.abs(outL) + Math.abs(outR) < 1e-6 ? echo.quiet + 1 : 0;
  return [outL, outR];
}

function color(echo: Echo, side: "l" | "r", x: number, knobs: Fx["delay"]): number {
  const hi = 0.05 + knobs.hi * 0.95;
  if (side === "l") echo.lpL = smooth(echo.lpL, x, hi);
  else echo.lpR = smooth(echo.lpR, x, hi);
  const lp = side === "l" ? echo.lpL : echo.lpR;
  const lo = 0.001 + knobs.lo * 0.08;
  if (side === "l") echo.hpL = smooth(echo.hpL, lp, lo);
  else echo.hpR = smooth(echo.hpR, lp, lo);
  const hpState = side === "l" ? echo.hpL : echo.hpR;
  return lp * (1 - knobs.lo) + (lp - hpState) * knobs.lo;
}

/** Sixteen knobs, then beats per bar, already mixed for this moment. */
export function formatFx(fx: Fx, beats: number): string {
  const nums = [
    ...FX_REVERB.map((key) => fx.reverb[key]),
    ...FX_DELAY.map((key) => fx.delay[key]),
    beats,
  ];
  return nums.map((n) => n.toFixed(4)).join(",");
}
