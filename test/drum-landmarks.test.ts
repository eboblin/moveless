import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRUM_NOTE, type DrumId } from "../src/core/types.ts";
import { mapFilter, mapSound } from "../src/dsp/map.ts";
import { createEngine, drumPitchHz, fmRatioOf, renderBlock } from "../src/dsp/voice.ts";

const SR = 44100;

type Sound = Record<string, number>;

const KICK: Record<string, Sound> = {
  "808": { pitch: 0.35, decay: 0.55, bend: 0.45, bendTime: 0.55, body: 0.08, click: 0.12, noise: 0.08, drive: 0.05 },
  "808 sub": { pitch: 0.15, decay: 0.85, bend: 0.35, bendTime: 0.7, body: 0.05, click: 0.05, noise: 0.02, drive: 0 },
  "909": { pitch: 0.42, decay: 0.28, bend: 0.38, bendTime: 0.22, body: 0.28, click: 0.55, noise: 0.15, drive: 0.12 },
  "909 click": { pitch: 0.48, decay: 0.18, bend: 0.3, bendTime: 0.12, body: 0.28, click: 0.85, noise: 0.2, drive: 0.2 },
  simmons: { pitch: 0.72, decay: 0.4, bend: 0.7, bendTime: 0.65, body: 0.12, click: 0.2, noise: 0.05, drive: 0.05 },
  techno: { pitch: 0.5, decay: 0.12, bend: 0.25, bendTime: 0.15, body: 0.55, click: 0.8, noise: 0.25, drive: 0.85 },
  membrane: { pitch: 0.4, decay: 0.45, bend: 0.4, bendTime: 0.4, body: 0.28, click: 0.15, noise: 0.1, drive: 0.05 },
  hollow: { pitch: 0.45, decay: 0.5, bend: 0.3, bendTime: 0.3, body: 0.78, click: 0.2, noise: 0.05, drive: 0.05 },
  industrial: { pitch: 0.38, decay: 0.35, bend: 0.5, bendTime: 0.3, body: 0.96, click: 0.6, noise: 0.55, drive: 0.95 },
  sine: { pitch: 0.4, decay: 0.5, bend: 0, bendTime: 0.2, body: 0, click: 0, noise: 0, drive: 0 },
  acoustic: { pitch: 0.48, decay: 0.42, bend: 0.35, bendTime: 0.35, body: 0.5, click: 0.35, noise: 0.22, drive: 0.08 },
  zap: { pitch: 0.85, decay: 0.22, bend: 0.85, bendTime: 0.45, body: 0.28, click: 0.4, noise: 0.1, drive: 0.15 },
};

const SNARE: Record<string, Sound> = {
  "808": { pitch: 0.29, body: 0.28, bodyDecay: 0.48, noise: 0.72, noiseDecay: 0.38, snap: 0.28, tone: 0.4, drive: 0.08 },
  "909": { pitch: 0.36, body: 0.28, bodyDecay: 0.3, noise: 0.62, noiseDecay: 0.22, snap: 0.7, tone: 0.52, drive: 0.12 },
  "cr snap": { pitch: 0.58, body: 0.28, bodyDecay: 0.1, noise: 0.28, noiseDecay: 0.08, snap: 0.92, tone: 0.78, drive: 0.05 },
  linn: { pitch: 0.34, body: 0.28, bodyDecay: 0.16, noise: 0.48, noiseDecay: 0.14, snap: 0.62, tone: 0.48, drive: 0.18 },
  rimshot: { pitch: 0.62, body: 0.5, bodyDecay: 0.14, noise: 0.22, noiseDecay: 0.1, snap: 0.88, tone: 0.7, drive: 0.08 },
  clack: { pitch: 0.7, body: 0.5, bodyDecay: 0.1, noise: 0.12, noiseDecay: 0.08, snap: 0.9, tone: 0.62, drive: 0.05 },
  woodblock: { pitch: 0.72, body: 0.5, bodyDecay: 0.22, noise: 0.06, noiseDecay: 0.08, snap: 0.4, tone: 0.28, drive: 0 },
  clave: { pitch: 0.82, body: 0.5, bodyDecay: 0.16, noise: 0.02, noiseDecay: 0.06, snap: 0.25, tone: 0.2, drive: 0 },
  clap: { pitch: 0.4, body: 0.08, bodyDecay: 0.12, noise: 0.95, noiseDecay: 0.55, snap: 0.35, tone: 0.42, drive: 0.12 },
  industrial: { pitch: 0.48, body: 0.9, bodyDecay: 0.38, noise: 0.4, noiseDecay: 0.3, snap: 0.45, tone: 0.82, drive: 0.85 },
  tight: { pitch: 0.36, body: 0.28, bodyDecay: 0.14, noise: 0.4, noiseDecay: 0.12, snap: 0.58, tone: 0.5, drive: 0.22 },
  "fat noise": { pitch: 0.3, body: 0.28, bodyDecay: 0.32, noise: 0.95, noiseDecay: 0.72, snap: 0.2, tone: 0.16, drive: 0.15 },
};

const HAT: Record<string, Sound> = {
  "808 closed": { pitch: 0.55, metal: 0.42, noise: 0.72, color: 0.5, decay: 0.18, attack: 0.35, ring: 0.22, pos: 0.5 },
  "808 open": { pitch: 0.55, metal: 0.42, noise: 0.72, color: 0.5, decay: 0.58, attack: 0.3, ring: 0.22, pos: 0.5 },
  "909 closed": { pitch: 0.62, metal: 0.48, noise: 0.6, color: 0.72, decay: 0.16, attack: 0.58, ring: 0.32, pos: 0.5 },
  "909 open": { pitch: 0.62, metal: 0.48, noise: 0.6, color: 0.75, decay: 0.64, attack: 0.45, ring: 0.32, pos: 0.5 },
  "cr78": { pitch: 0.4, metal: 0.36, noise: 0.8, color: 0.4, decay: 0.22, attack: 0.3, ring: 0.15, pos: 0.5 },
  shaker: { pitch: 0.35, metal: 0.04, noise: 0.88, color: 0.45, decay: 0.28, attack: 0.2, ring: 0.08, pos: 0.5 },
  classic: { pitch: 0.58, metal: 0.48, noise: 0.55, color: 0.6, decay: 0.25, attack: 0.4, ring: 0.4, pos: 0.5 },
  "thin ring": { pitch: 0.7, metal: 0.78, noise: 0.22, color: 0.82, decay: 0.4, attack: 0.3, ring: 0.88, pos: 0.5 },
  triangle: { pitch: 0.48, metal: 0.84, noise: 0.08, color: 0.65, decay: 0.72, attack: 0.25, ring: 0.9, pos: 0.5 },
  cymbal: { pitch: 0.32, metal: 0.9, noise: 0.35, color: 0.55, decay: 0.78, attack: 0.4, ring: 0.7, pos: 0.5 },
  bell: { pitch: 0.42, metal: 0.96, noise: 0.12, color: 0.7, decay: 0.62, attack: 0.35, ring: 0.82, pos: 0.5 },
  left: { pitch: 0.6, metal: 0.72, noise: 0.4, color: 0.6, decay: 0.4, attack: 0.4, ring: 0.5, pos: 0 },
};

const PERC: Record<string, Sound> = {
  tom: { pitch: 0.22, material: 0.08, decay: 0.48, bend: 0.12, fm: 0, fmRatio: 0.06, attack: 0.28, damp: 0.55 },
  conga: { pitch: 0.35, material: 0.08, decay: 0.35, bend: 0.25, fm: 0, fmRatio: 0.06, attack: 0.45, damp: 0.4 },
  bongo: { pitch: 0.48, material: 0.1, decay: 0.22, bend: 0.2, fm: 0, fmRatio: 0.06, attack: 0.5, damp: 0.35 },
  clave: { pitch: 0.78, material: 0.24, decay: 0.12, bend: 0.05, fm: 0.05, fmRatio: 0.21, attack: 0.4, damp: 0.3 },
  woodblock: { pitch: 0.7, material: 0.24, decay: 0.18, bend: 0, fm: 0, fmRatio: 0.21, attack: 0.55, damp: 0.45 },
  cowbell: { pitch: 0.62, material: 0.58, decay: 0.42, bend: 0, fm: 0.1, fmRatio: 0.36, attack: 0.4, damp: 0.18 },
  agogo: { pitch: 0.72, material: 0.58, decay: 0.32, bend: 0, fm: 0.05, fmRatio: 0.36, attack: 0.35, damp: 0.12 },
  rim: { pitch: 0.66, material: 0.24, decay: 0.1, bend: 0, fm: 0, fmRatio: 0.21, attack: 0.88, damp: 0.62 },
  tabla: { pitch: 0.4, material: 0.42, decay: 0.28, bend: 0.35, fm: 0.15, fmRatio: 0.51, attack: 0.4, damp: 0.22 },
  "simmons tom": { pitch: 0.38, material: 0.08, decay: 0.4, bend: 0.72, fm: 0.05, fmRatio: 0.36, attack: 0.25, damp: 0.2 },
  laser: { pitch: 0.55, material: 0.92, decay: 0.35, bend: 0.9, fm: 0.7, fmRatio: 0.51, attack: 0.2, damp: 0.1 },
  zap: { pitch: 0.6, material: 0.9, decay: 0.18, bend: 0.85, fm: 0.55, fmRatio: 0.36, attack: 0.35, damp: 0.15 },
  "fm blip": { pitch: 0.5, material: 0.92, decay: 0.12, bend: 0.1, fm: 0.82, fmRatio: 0.66, attack: 0.2, damp: 0.2 },
  bell: { pitch: 0.58, material: 0.58, decay: 0.72, bend: 0, fm: 0.2, fmRatio: 0.51, attack: 0.3, damp: 0.05 },
  metal: { pitch: 0.64, material: 0.74, decay: 0.45, bend: 0.05, fm: 0.25, fmRatio: 0.51, attack: 0.4, damp: 0.1 },
};

function hit(lane: DrumId, sound: Sound, frames = SR): Float32Array {
  return renderBlock(createEngine(), [{
    sampleOffset: 0,
    lane,
    note: DRUM_NOTE[lane],
    velocity: 110,
    lengthTicks: 48,
    params: [...mapSound(lane, sound), ...mapFilter({ cutoff: 0.5, resonance: 0 })],
  }], 120, frames);
}

function mono(buf: Float32Array): Float32Array {
  const n = buf.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * (buf[i * 2] + buf[i * 2 + 1]);
  return out;
}

function decayTime(buf: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const thr = peak * 0.01;
  let last = 0;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > thr) last = i;
  return last / SR;
}

function rms(buf: Float32Array, a: number, b: number): number {
  let energy = 0;
  const end = Math.min(buf.length, b);
  for (let i = a; i < end; i++) energy += buf[i] * buf[i];
  return Math.sqrt(energy / Math.max(1, end - a));
}

function zcHz(buf: Float32Array, start: number, len: number): number {
  let crosses = 0;
  let prev = buf[start] ?? 0;
  const end = Math.min(buf.length, start + len);
  for (let i = start + 1; i < end; i++) {
    const sample = buf[i];
    if ((prev <= 0 && sample > 0) || (prev >= 0 && sample < 0)) crosses += 1;
    prev = sample;
  }
  return (crosses / 2) * SR / Math.max(1, end - start);
}

function f0(buf: Float32Array, start: number, len: number, minHz: number, maxHz: number): number {
  const lo = Math.max(1, Math.floor(SR / maxHz));
  const hi = Math.min(len - 2, Math.floor(SR / minHz));
  let best = 0;
  let lag = lo;
  const end = Math.min(buf.length, start + len);
  for (let k = lo; k <= hi; k++) {
    if (end - start - k < 200) break;
    let corr = 0;
    let energy = 0;
    for (let i = start; i < end - k; i += 2) {
      corr += buf[i] * buf[i + k];
      energy += buf[i] * buf[i];
    }
    const norm = energy > 1e-8 ? corr / energy : 0;
    if (norm > best) {
      best = norm;
      lag = k;
    }
  }
  return SR / lag;
}

function band(buf: Float32Array, hz: number, start: number, len: number): number {
  const w = (2 * Math.PI * hz) / SR;
  let re = 0;
  let im = 0;
  for (let i = 0; i < len; i++) {
    const s = buf[start + i] ?? 0;
    re += s * Math.cos(w * i);
    im -= s * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im);
}

function centroid(buf: Float32Array, start: number, len: number): number {
  const bands = [80, 200, 500, 1200, 3000, 7000];
  let num = 0;
  let den = 0;
  const n = Math.min(len, 1024);
  for (const hz of bands) {
    const w = (2 * Math.PI * hz) / SR;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const s = buf[start + i] ?? 0;
      re += s * Math.cos(w * i);
      im -= s * Math.sin(w * i);
    }
    const energy = re * re + im * im;
    num += hz * energy;
    den += energy;
  }
  return den > 0 ? num / den : 0;
}

function audible(lane: DrumId, book: Record<string, Sound>): void {
  for (const [name, sound] of Object.entries(book)) {
    assert.equal(Object.keys(sound).length, 8, name);
    for (const value of Object.values(sound)) assert.ok(value >= 0 && value <= 1, name);
    const audio = hit(lane, sound, 4096);
    let peak = 0;
    for (const sample of audio) {
      assert.ok(Number.isFinite(sample), name);
      peak = Math.max(peak, Math.abs(sample));
    }
    assert.ok(peak > 0.02, name);
  }
}

describe("drum landmarks", () => {
  it("keeps an FM ratio shelf wider than a 0.05 nudge", () => {
    for (const center of [0.06, 0.21, 0.36, 0.51, 0.66, 0.81, 0.96]) {
      const ratio = fmRatioOf(center);
      assert.equal(fmRatioOf(center - 0.05), ratio);
      assert.equal(fmRatioOf(Math.min(1, center + 0.05)), ratio);
    }
    assert.equal(fmRatioOf(0.06), 1);
    assert.equal(fmRatioOf(0.51), 3);
    assert.equal(fmRatioOf(0.96), 7);
  });

  it("reaches kick landmarks without a lucky knob", () => {
    audible("kick", KICK);
    const voice = (sound: Sound) => mono(hit("kick", { ...sound, click: 0, noise: 0, drive: 0 }, Math.floor(SR * 0.7)));
    const tail = (sound: Sound) => decayTime(mono(hit("kick", sound, Math.floor(SR * 1.4))));
    const late = (sound: Sound) => rms(mono(hit("kick", sound, Math.floor(SR * 0.9))), Math.floor(SR * 0.55), Math.floor(SR * 0.75));
    assert.ok(tail(KICK["808"]) > tail(KICK["909"]) + 0.05);
    assert.ok(late(KICK["808 sub"]) > late(KICK["808"]));
    assert.ok(tail(KICK.techno) < tail(KICK["909"]));
    const pitchOf = (sound: Sound) => zcHz(voice(sound), Math.floor(SR * 0.42), 2400);
    assert.ok(pitchOf(KICK["808 sub"]) < pitchOf(KICK["808"]));
    assert.ok(pitchOf(KICK.simmons) > pitchOf(KICK["808"]));
    assert.ok(pitchOf(KICK.zap) > pitchOf(KICK.simmons));
    const held = (sound: Sound) => {
      const audio = voice(sound);
      const late = zcHz(audio, Math.floor(SR * 0.08), 2000);
      return late / drumPitchHz(0, sound.pitch);
    };
    assert.ok(held(KICK["808"]) > held(KICK["909"]) + 0.2);
    assert.ok(held(KICK.sine) < 1.25);
    const bite = (sound: Sound) => {
      const audio = mono(hit("kick", sound, 2000));
      let energy = 0;
      let prev = 0;
      for (let i = 0; i < 180; i++) {
        const delta = audio[i] - prev;
        energy += delta * delta;
        prev = audio[i];
      }
      return energy;
    };
    assert.ok(bite(KICK.techno) > bite(KICK.sine) * 8);
    assert.ok(bite(KICK["909 click"]) > bite(KICK["808"]) * 4);
    const bright = (body: number) => centroid(voice({ ...KICK.sine, body, decay: 0.45 }), 200, 800);
    assert.ok(bright(0.78) > bright(0) * 1.15);
    assert.ok(bright(0.96) > bright(0.28));
    for (const body of [0.08, 0.28, 0.5, 0.78, 0.96]) {
      const mid = bright(body);
      const near = bright(Math.min(1, body + 0.05));
      const far = bright(Math.min(1, body + 0.22));
      assert.ok(Math.abs(near - mid) < Math.abs(far - mid) + 40, `body ${body}`);
    }
    const hiss = (sound: Sound) => rms(mono(hit("kick", sound, 4000)), 0, 800);
    assert.ok(hiss(KICK.industrial) > hiss(KICK.sine));
  });

  it("reaches snare landmarks from a long noise tail to a short wooden knock", () => {
    audible("snare", SNARE);
    const tail = (sound: Sound) => decayTime(mono(hit("snare", sound, Math.floor(SR * 0.8))));
    assert.ok(tail(SNARE["808"]) > tail(SNARE["909"]));
    assert.ok(tail(SNARE["fat noise"]) > tail(SNARE.tight));
    assert.ok(tail(SNARE.woodblock) < tail(SNARE["808"]));
    const wires = (sound: Sound) => rms(mono(hit("snare", sound, Math.floor(SR * 0.25))), Math.floor(SR * 0.04), Math.floor(SR * 0.09));
    assert.ok(wires(SNARE["808"]) > wires(SNARE["909"]));
    const lateHigh = (sound: Sound) => {
      const audio = mono(hit("snare", sound, Math.floor(SR * 0.25)));
      let prev = 0;
      let energy = 0;
      const a = Math.floor(SR * 0.12);
      const b = Math.floor(SR * 0.2);
      for (let i = a; i < b; i++) {
        const d = audio[i] - prev;
        energy += d * d;
        prev = audio[i];
      }
      return energy;
    };
    assert.ok(lateHigh(SNARE.clap) > lateHigh(SNARE.clave) * 2);
    const edge = (body: number) => {
      const audio = mono(hit("snare", {
        pitch: 0.4, body, bodyDecay: 0.5, noise: 0, noiseDecay: 0, snap: 0, tone: 0.55, drive: 0,
      }, 4000));
      let energy = 0;
      let prev = 0;
      for (let i = 200; i < 900; i++) {
        const delta = audio[i] - prev;
        energy += delta * delta;
        prev = audio[i];
      }
      return energy;
    };
    assert.ok(edge(0.28) > edge(0.08) * 2);
    const crack = (sound: Sound) => {
      const audio = mono(hit("snare", sound, 2000));
      let early = 0;
      let late = 0;
      for (let i = 0; i < 30; i++) early += audio[i] * audio[i];
      for (let i = 80; i < 400; i++) late += audio[i] * audio[i];
      return early / Math.max(1e-6, late);
    };
    assert.ok(crack(SNARE["cr snap"]) > crack(SNARE["fat noise"]) * 2);
    const snapTail = (snap: number) => {
      const audio = mono(hit("snare", {
        pitch: 0.4, body: 0.28, bodyDecay: 0.35, noise: 0.05, noiseDecay: 0.05, snap, tone: 0.2, drive: 0,
      }, 1500));
      let early = 0;
      let late = 0;
      for (let i = 0; i < 36; i++) early += audio[i] * audio[i];
      for (let i = 90; i < 220; i++) late += audio[i] * audio[i];
      return late / Math.max(1e-6, early);
    };
    assert.ok(snapTail(0.35) > snapTail(0.6) && snapTail(0.6) > snapTail(0.9));
    const noiseAt = (pitch: number) => {
      const audio = mono(hit("snare", {
        pitch, body: 0.08, bodyDecay: 0.25, noise: 0.9, noiseDecay: 0.4, snap: 0, tone: 0.5, drive: 0,
      }, 2500));
      return band(audio, 10000, 80, 700) / Math.max(0.05, band(audio, 200, 80, 700));
    };
    assert.ok(noiseAt(0.82) > noiseAt(0.5) && noiseAt(0.5) > noiseAt(0.22) * 2);
    const tone = (value: number) => band(mono(hit("snare", {
      pitch: 0.45, body: 0.5, bodyDecay: 0.4, noise: 0.7, noiseDecay: 0.35, snap: 0.2, tone: value, drive: 0,
    }, 3000)), 10000, 100, 700);
    assert.ok(tone(0.85) > tone(0.5) && tone(0.5) > tone(0.18));
    assert.ok(Math.abs(tone(0.5) - tone(0.55)) < Math.abs(tone(0.5) - tone(0.18)));
    const body = (value: number) => centroid(mono(hit("snare", {
      pitch: 0.45, body: value, bodyDecay: 0.45, noise: 0, noiseDecay: 0, snap: 0, tone: 0.5, drive: 0,
    }, 3000)), 150, 800);
    assert.ok(body(0.9) > body(0.08));
    for (const value of [0.08, 0.28, 0.5, 0.75, 0.9]) {
      const mid = body(value);
      const near = body(Math.min(1, value + 0.05));
      const far = body(Math.max(0, value - 0.22));
      assert.ok(Math.abs(near - mid) < Math.abs(far - mid) + 80, `body ${value}`);
    }
    const pitch = (sound: Sound) => zcHz(mono(hit("snare", { ...sound, noise: 0, snap: 0, drive: 0 }, 4000)), 30, 900);
    assert.ok(pitch(SNARE.clave) > pitch(SNARE["808"]));
  });

  it("reaches hat landmarks from a shaker to a wide cymbal", () => {
    audible("hat", HAT);
    const tail = (sound: Sound) => decayTime(mono(hit("hat", sound, Math.floor(SR * 1.1))));
    assert.ok(tail(HAT["808 open"]) > tail(HAT["808 closed"]) + 0.08);
    assert.ok(tail(HAT["909 open"]) > tail(HAT["909 closed"]) + 0.08);
    assert.ok(tail(HAT.triangle) > tail(HAT.shaker));
    const metalShare = (sound: Sound) => {
      const full = rms(mono(hit("hat", sound, 2500)), 200, 1200);
      const dry = rms(mono(hit("hat", { ...sound, metal: 0 }, 2500)), 200, 1200);
      return full / Math.max(1e-6, dry);
    };
    assert.ok(metalShare(HAT.bell) > metalShare(HAT.shaker));
    const sideEnergy = (buf: Float32Array, channel: 0 | 1) => {
      let energy = 0;
      for (let i = channel; i < buf.length; i += 2) energy += buf[i] * buf[i];
      return energy;
    };
    const panned = hit("hat", HAT.left, 4000);
    const centered = hit("hat", HAT["808 closed"], 4000);
    assert.ok(sideEnergy(panned, 0) > sideEnergy(panned, 1) * 20);
    assert.ok(Math.abs(sideEnergy(centered, 0) - sideEnergy(centered, 1)) < sideEnergy(centered, 0) * 0.02);
    const color = (value: number) => centroid(mono(hit("hat", {
      pitch: 0.55, metal: 0.2, noise: 0.8, color: value, decay: 0.3, attack: 0.2, ring: 0.2, pos: 0.5,
    }, 3000)), 80, 600);
    assert.ok(color(0.85) > color(0.2));
    const toneShare = (value: number) => {
      const audio = mono(hit("hat", {
        pitch: 0.55, metal: value, noise: 0.35, color: 0.55, decay: 0.35, attack: 0.15, ring: 0.4, pos: 0.5,
      }, 3000));
      const period = f0(audio, 120, 600, 200, 5000);
      const lag = Math.max(1, Math.round(SR / period));
      let corr = 0;
      let energy = 0;
      for (let i = 120; i < 700; i++) {
        corr += audio[i] * (audio[i + lag] ?? 0);
        energy += audio[i] * audio[i];
      }
      return energy > 1e-9 ? corr / energy : 0;
    };
    for (const value of [0.04, 0.42, 0.78, 0.96]) {
      const mid = toneShare(value);
      const near = toneShare(Math.min(1, value + 0.05));
      const far = toneShare(Math.min(1, value + 0.28));
      assert.ok(Math.abs(near - mid) <= Math.abs(far - mid) + 0.08, `metal ${value}`);
    }
    assert.ok(toneShare(0.9) > toneShare(0.04) + 0.15);
    const chick = (velocity: number) => mono(renderBlock(createEngine(), [{
      sampleOffset: 0,
      lane: "hat",
      note: DRUM_NOTE.hat,
      velocity,
      lengthTicks: 48,
      params: [...mapSound("hat", {
        pitch: 0.6, metal: 0, noise: 0, color: 0.5, decay: 0.05, attack: 0.85, ring: 0, pos: 0.5,
      }), ...mapFilter({ cutoff: 0.5, resonance: 0 })],
    }], 120, 1500));
    assert.ok(rms(chick(28), 0, 160) < rms(chick(112), 0, 160) * 0.5);
    const sweep = chick(110);
    let energy = 0;
    for (let i = 0; i < 96; i++) energy += sweep[i] * sweep[i];
    let best = 0;
    for (let lag = 3; lag <= 40; lag++) {
      let corr = 0;
      for (let i = 0; i < 96; i++) corr += sweep[i] * (sweep[i + lag] ?? 0);
      if (corr > best) best = corr;
    }
    assert.ok(energy > 1e-6 && best < energy * 0.55);
  });

  it("reaches perc landmarks from a tom to an FM blip", () => {
    audible("perc", PERC);
    const voice = (sound: Sound) => mono(hit("perc", { ...sound, attack: 0, fm: 0, bend: 0 }, 5000));
    const pitch = (sound: Sound) => zcHz(voice(sound), 24, 700);
    assert.ok(pitch(PERC.clave) > pitch(PERC.tom) * 1.5);
    assert.ok(pitch(PERC.woodblock) > pitch(PERC.conga));
    const sweep = (sound: Sound) => {
      const audio = mono(hit("perc", { ...sound, attack: 0 }, Math.floor(SR * 0.12)));
      return zcHz(audio, 30, 260) / drumPitchHz(3, sound.pitch);
    };
    assert.ok(sweep(PERC.laser) > sweep(PERC.cowbell) + 2);
    assert.ok(sweep(PERC["simmons tom"]) > sweep(PERC.tom) + 1);
    const bright = (material: number) => centroid(mono(hit("perc", {
      pitch: 0.5, material, decay: 0.4, bend: 0, fm: 0, fmRatio: 0.06, attack: 0, damp: 0.1,
    }, 3000)), 120, 700);
    assert.ok(bright(0.92) > bright(0.08));
    for (const material of [0.08, 0.24, 0.42, 0.58, 0.74, 0.92]) {
      const mid = bright(material);
      const near = bright(Math.min(1, material + 0.05));
      const far = bright(Math.max(0, material - 0.2));
      assert.ok(Math.abs(near - mid) < Math.abs(far - mid) + 100, `material ${material}`);
    }
    const drop = (damp: number) => {
      const audio = mono(hit("perc", {
        pitch: 0.55, material: 0.74, decay: 0.55, bend: 0, fm: 0, fmRatio: 0.06, attack: 0, damp,
      }, 8000));
      const partial = drumPitchHz(3, 0.55) * 2.7;
      const late = Math.floor(SR * 0.08);
      return band(audio, partial, 40, 400) / band(audio, partial, late, 500);
    };
    assert.ok(drop(0.9) > drop(0.05) * 1.4);
    const blip = centroid(mono(hit("perc", PERC["fm blip"], 2500)), 40, 400);
    const tom = centroid(mono(hit("perc", { ...PERC.tom, pitch: PERC["fm blip"].pitch }, 2500)), 40, 400);
    assert.ok(blip > tom);
    const fmEdge = (fm: number) => zcHz(mono(hit("perc", {
      pitch: 0.4, material: 0.08, decay: 0.48, bend: 0, fm, fmRatio: 0.51, attack: 0, damp: 0.5,
    }, 2500)), 10, 600);
    assert.ok(fmEdge(0.7) > fmEdge(0.25) && fmEdge(0.25) > fmEdge(0.08) && fmEdge(0.08) > fmEdge(0));
    const ratioTone = (fmRatio: number) => zcHz(mono(hit("perc", {
      pitch: 0.4, material: 0.08, decay: 0.48, bend: 0, fm: 0.25, fmRatio, attack: 0, damp: 0.45,
    }, 2500)), 10, 600);
    assert.ok(ratioTone(0.96) > ratioTone(0.51) && ratioTone(0.51) > ratioTone(0.06));
    const quiet = (fmRatio: number) => zcHz(mono(hit("perc", {
      pitch: 0.4, material: 0.08, decay: 0.48, bend: 0, fm: 0, fmRatio, attack: 0, damp: 0.5,
    }, 2500)), 10, 600);
    assert.ok(Math.abs(quiet(0.96) - quiet(0.06)) < 8);
  });
});
