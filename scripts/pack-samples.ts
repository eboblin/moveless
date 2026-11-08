// Builds samples.bin from the Strudel drum map and the GM preset list.
// Downloads are cached in samples-cache/ and are not committed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { DRUM_BASE, GM_BASE, GM_SAMPLES, HAT_SAMPLES, KICK_SAMPLES, PERC_SAMPLES, SNARE_SAMPLES, type SampleName } from "../src/core/sample-catalog.ts";
import { assembleBank, encodeBank, type SampleSlot, type SampleZone } from "../src/dsp/bank.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "samples-cache");
const OUT = path.join(ROOT, "samples.bin");
const RATE = 44100;

const DRUM_MIRRORS = [
  DRUM_BASE,
  "https://strudel.b-cdn.net/tidal-drum-machines/machines/",
  "https://raw.githubusercontent.com/geikha/tidal-drum-machines/main/machines/",
];

interface FontZone {
  originalPitch?: number;
  keyRangeLow?: number;
  keyRangeHigh?: number;
  loopStart?: number;
  loopEnd?: number;
  coarseTune?: number;
  fineTune?: number;
  sampleRate?: number;
  file?: string;
}

const pcmChunks: Int16Array[] = [];
let pcmFrames = 0;

function fail(message: string): never {
  throw new Error(message);
}

function cacheFile(kind: string, key: string): string {
  const name = createHash("sha1").update(key).digest("hex");
  return path.join(CACHE, kind, name);
}

async function fetchCached(kind: string, key: string, urls: string[]): Promise<Buffer> {
  const dest = cacheFile(kind, key);
  if (existsSync(dest) && statSync(dest).size > 0) return readFileSync(dest);
  let last = "no response";
  for (const url of urls) {
    const response = await fetch(url);
    if (!response.ok) {
      last = `${response.status} ${url}`;
      continue;
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 1) {
      last = `empty ${url}`;
      continue;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    return body;
  }
  return fail(`missing ${key}: ${last}`);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[at + i] ?? 0);
  return text;
}

function decodeWav(bytes: Uint8Array): { rate: number; samples: Float32Array } {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") fail("not a wav");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = 0;
  let channels = 1;
  let rate = RATE;
  let bits = 16;
  let data: Uint8Array | null = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const start = pos + 8;
    if (id === "fmt " && size >= 16) {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      rate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
      if (format === 0xfffe && size >= 40) format = view.getUint16(start + 24, true);
    } else if (id === "data") {
      data = bytes.subarray(start, Math.min(bytes.length, start + size));
    }
    pos = start + size + (size & 1);
  }
  if (!data || channels < 1 || rate < 1) fail("wav has no data");
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bytesPer = Math.max(1, Math.ceil(bits / 8));
  const frames = Math.floor(data.length / (bytesPer * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const at = (frame * channels + channel) * bytesPer;
      if (format === 3 && bits === 32) sum += dataView.getFloat32(at, true);
      else if (format === 1 && bits === 8) sum += ((data[at] ?? 128) - 128) / 128;
      else if (format === 1 && bits === 16) sum += dataView.getInt16(at, true) / 32768;
      else if (format === 1 && bits === 24) {
        const b0 = data[at] ?? 0;
        const b1 = data[at + 1] ?? 0;
        const b2 = data[at + 2] ?? 0;
        let value = b0 | (b1 << 8) | (b2 << 16);
        if (value & 0x800000) value |= ~0xffffff;
        sum += value / 8388608;
      } else if (format === 1 && bits === 32) sum += dataView.getInt32(at, true) / 2147483648;
      else fail(`wav format ${format} bits ${bits}`);
    }
    samples[frame] = sum / channels;
  }
  return { rate, samples };
}

function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (samples.length < 1) return samples;
  if (Math.abs(from - to) < 0.5) return samples;
  const length = Math.max(1, Math.round(samples.length * to / from));
  const out = new Float32Array(length);
  const scale = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * scale;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = samples[index] ?? 0;
    const b = samples[Math.min(samples.length - 1, index + 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.round((samples[i] ?? 0) * 32767);
    out[i] = value < -32768 ? -32768 : value > 32767 ? 32767 : value;
  }
  return out;
}

function pushPcm(samples: Int16Array): number {
  const offset = pcmFrames;
  pcmChunks.push(samples);
  pcmFrames += samples.length;
  return offset;
}

function ffmpegPcm(encoded: Buffer, label: string): Int16Array {
  const mp3 = ascii(encoded, 0, 3) === "ID3" || (encoded[0] === 0xff && ((encoded[1] ?? 0) & 0xe0) === 0xe0);
  const run = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    ...(mp3 ? ["-f", "mp3"] : []),
    "-i", "pipe:0",
    "-ac", "1", "-ar", String(RATE),
    "-f", "s16le", "pipe:1",
  ], { input: encoded, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  const raw = run.stdout;
  const stderr = Buffer.isBuffer(run.stderr) ? run.stderr.toString("utf8") : "";
  if (run.error) fail(`${label}: ffmpeg: ${run.error.message}`);
  if (run.status !== 0 || !Buffer.isBuffer(raw) || raw.length < 2) {
    if (encoded.length < 512) {
      console.warn(`${label}: зона без кадров MPEG, ${encoded.length} байт, в банк уходит тишина`);
      return new Int16Array(1);
    }
    fail(`${label}: ffmpeg failed: ${stderr}`);
  }
  const out = new Int16Array(raw.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = raw.readInt16LE(i * 2);
  return out;
}

function zoneFromPcm(pcm: Int16Array, zone: Omit<SampleZone, "offset" | "length" | "sampleRate"> & { sampleRate?: number }): SampleZone {
  return {
    offset: pushPcm(pcm),
    length: pcm.length,
    loopStart: zone.loopStart,
    loopEnd: zone.loopEnd,
    originalPitch: zone.originalPitch,
    coarseTune: zone.coarseTune,
    fineTune: zone.fineTune,
    sampleRate: RATE,
    keyLo: zone.keyLo,
    keyHi: zone.keyHi,
    hasLoop: zone.hasLoop,
  };
}

async function drumSlot(entry: SampleName): Promise<SampleZone[]> {
  const urls = DRUM_MIRRORS.map((base) => base + encodeURI(entry.file));
  const bytes = await fetchCached("drums", entry.file, urls);
  const wav = decodeWav(bytes);
  const audio = toInt16(resample(wav.samples, wav.rate, RATE));
  if (audio.length < 1) fail(`empty drum ${entry.file}`);
  return [zoneFromPcm(audio, {
    loopStart: 0,
    loopEnd: 0,
    originalPitch: 6000,
    coarseTune: 0,
    fineTune: 0,
    keyLo: 0,
    keyHi: 127,
    hasLoop: false,
  })];
}

function loadFont(source: string, id: string): FontZone[] {
  const named = source.match(/var\s+(_tone_[A-Za-z0-9_]+)\s*=/);
  if (!named) fail(`no preset object in ${id}`);
  const name = named[1] ?? "";
  const sandbox: Record<string, unknown> = { console: { log() {} } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: `${id}.js` });
  const tone = sandbox[name];
  if (!tone || typeof tone !== "object" || !("zones" in tone) || !Array.isArray(tone.zones)) fail(`no zones in ${id}`);
  return tone.zones as FontZone[];
}

async function gmSlot(entry: SampleName): Promise<SampleZone[]> {
  const urls = [`${GM_BASE}${entry.file}.js`];
  // gm.mjs spells this one sf2_fible. The file on the font host is sf2_file.
  if (entry.file.endsWith("_fible")) urls.push(`${GM_BASE}${entry.file.replace(/_fible$/, "_file")}.js`);
  const bytes = await fetchCached("gm", entry.file, urls);
  const zones = loadFont(bytes.toString("utf8"), entry.file);
  if (zones.length < 1) fail(`no zones in ${entry.file}`);
  const out: SampleZone[] = [];
  for (const zone of zones) {
    if (typeof zone.file !== "string" || zone.file.length < 8) fail(`zone without audio in ${entry.file}`);
    const payload = zone.file.includes(",") ? zone.file.slice(zone.file.indexOf(",") + 1) : zone.file;
    const encoded = Buffer.from(payload, "base64");
    if (encoded.length < 8) fail(`bad audio in ${entry.file}`);
    const sourceRate = zone.sampleRate && zone.sampleRate > 1 ? zone.sampleRate : RATE;
    const loopStart = zone.loopStart ?? 0;
    const loopEnd = zone.loopEnd ?? 0;
    const hasLoop = loopStart > 1 && loopStart < loopEnd;
    let pcm: Int16Array;
    let usedRate = sourceRate;
    if (ascii(encoded, 0, 4) === "RIFF") {
      const wav = decodeWav(encoded);
      usedRate = wav.rate;
      pcm = toInt16(resample(wav.samples, wav.rate, RATE));
    } else {
      pcm = ffmpegPcm(encoded, entry.file);
    }
    const scale = RATE / usedRate;
    if (pcm.length < 1) fail(`empty zone in ${entry.file}`);
    const scaledStart = Math.max(0, Math.min(pcm.length, Math.round(loopStart * scale)));
    const scaledEnd = Math.max(0, Math.min(pcm.length, Math.round(loopEnd * scale)));
    out.push(zoneFromPcm(pcm, {
      loopStart: scaledStart,
      loopEnd: scaledEnd,
      originalPitch: zone.originalPitch ?? 6000,
      coarseTune: zone.coarseTune ?? 0,
      fineTune: zone.fineTune ?? 0,
      keyLo: Math.max(0, Math.min(127, Math.round(zone.keyRangeLow ?? 0))),
      keyHi: Math.max(0, Math.min(127, Math.round(zone.keyRangeHigh ?? 127))),
      hasLoop: hasLoop && scaledEnd > scaledStart,
    }));
  }
  return out;
}

async function packList(kind: string, list: readonly SampleName[], one: (entry: SampleName) => Promise<SampleZone[]>): Promise<SampleSlot[]> {
  const slots: SampleSlot[] = [];
  let zoneIndex = 0;
  const zones: SampleZone[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry) continue;
    const taken = await one(entry);
    zones.push(...taken);
    slots.push({ zoneIndex, zoneCount: taken.length });
    zoneIndex += taken.length;
    if ((i + 1) % 25 === 0 || i + 1 === list.length) console.log(`${kind} ${i + 1}/${list.length}`);
  }
  packedZones.push(...zones);
  return slots;
}

const packedZones: SampleZone[] = [];

const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (ffmpeg.error || ffmpeg.status !== 0) fail("нужен ffmpeg в PATH: им декодируются mp3 пресетов GM");

const lists: { kind: string; list: readonly SampleName[]; one: (entry: SampleName) => Promise<SampleZone[]> }[] = [
  { kind: "kick", list: KICK_SAMPLES, one: drumSlot },
  { kind: "snare", list: SNARE_SAMPLES, one: drumSlot },
  { kind: "hat", list: HAT_SAMPLES, one: drumSlot },
  { kind: "perc", list: PERC_SAMPLES, one: drumSlot },
  { kind: "gm", list: GM_SAMPLES, one: gmSlot },
];

const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
const slots: SampleSlot[] = [];
let zoneCursor = 0;

for (let catalog = 0; catalog < lists.length; catalog++) {
  const item = lists[catalog];
  if (!item) continue;
  const before = packedZones.length;
  const taken = await packList(item.kind, item.list, item.one);
  for (const slot of taken) slots.push({ zoneIndex: zoneCursor + slot.zoneIndex, zoneCount: slot.zoneCount });
  zoneCursor += packedZones.length - before;
  counts[catalog] = item.list.length;
}

const pcm = new Int16Array(pcmFrames);
let at = 0;
for (const chunk of pcmChunks) {
  pcm.set(chunk, at);
  at += chunk.length;
}

const bank = assembleBank(counts, slots, packedZones, pcm);
writeFileSync(OUT, encodeBank(bank));
console.log(`samples.bin ${counts.join(" ")} slots, ${packedZones.length} zones, ${pcmFrames} frames`);
