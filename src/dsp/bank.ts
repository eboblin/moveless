/**
 * Packed sample bank. Little-endian, shared with dsp/src/sample.c.
 *
 *  0  magic "MVLS"
 *  4  version u32 = 1
 *  8  slotCount u32
 * 12  zoneCount u32
 * 16  pcmFrames u32
 * 20  catalogCount u32[5]  kick, snare, hat, perc, gm
 * 40  slots: zoneIndex u32, zoneCount u16, pad u16
 *      zones, 36 bytes:
 *        offset, length, loopStart, loopEnd  u32
 *        originalPitch, coarseTune, fineTune, sampleRate  f32
 *        keyLo, keyHi, hasLoop, pad  u8
 *      pcm int16
 */

export interface SampleZone {
  offset: number;
  length: number;
  loopStart: number;
  loopEnd: number;
  originalPitch: number;
  coarseTune: number;
  fineTune: number;
  sampleRate: number;
  keyLo: number;
  keyHi: number;
  hasLoop: boolean;
}

export interface SampleSlot {
  zoneIndex: number;
  zoneCount: number;
}

export interface SampleBank {
  /** Slot counts: kick, snare, hat, perc, then the shared GM list. */
  counts: [number, number, number, number, number];
  starts: [number, number, number, number, number];
  slots: SampleSlot[];
  zones: SampleZone[];
  pcm: Int16Array;
}

const ZONE_BYTES = 36;
const SLOT_BYTES = 8;
const HEADER_BYTES = 40;

/** Drum lanes 0..3, and every melodic lane shares catalog 4. */
export function sampleCatalogIndex(lane: number): number {
  return lane < 4 ? lane : 4;
}

export function assembleBank(
  counts: [number, number, number, number, number],
  slots: SampleSlot[],
  zones: SampleZone[],
  pcm: Int16Array,
): SampleBank {
  const starts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (let i = 1; i < 5; i++) starts[i] = starts[i - 1] + counts[i - 1];
  return { counts, starts, slots, zones, pcm };
}

export function encodeBank(bank: SampleBank): Uint8Array {
  const bytes = HEADER_BYTES + bank.slots.length * SLOT_BYTES + bank.zones.length * ZONE_BYTES + bank.pcm.byteLength;
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  out[0] = 77;
  out[1] = 86;
  out[2] = 76;
  out[3] = 83;
  view.setUint32(4, 1, true);
  view.setUint32(8, bank.slots.length, true);
  view.setUint32(12, bank.zones.length, true);
  view.setUint32(16, bank.pcm.length, true);
  for (let i = 0; i < 5; i++) view.setUint32(20 + i * 4, bank.counts[i], true);
  let at = HEADER_BYTES;
  for (const slot of bank.slots) {
    view.setUint32(at, slot.zoneIndex, true);
    view.setUint16(at + 4, slot.zoneCount, true);
    at += SLOT_BYTES;
  }
  for (const zone of bank.zones) {
    view.setUint32(at, zone.offset, true);
    view.setUint32(at + 4, zone.length, true);
    view.setUint32(at + 8, zone.loopStart, true);
    view.setUint32(at + 12, zone.loopEnd, true);
    view.setFloat32(at + 16, zone.originalPitch, true);
    view.setFloat32(at + 20, zone.coarseTune, true);
    view.setFloat32(at + 24, zone.fineTune, true);
    view.setFloat32(at + 28, zone.sampleRate, true);
    out[at + 32] = zone.keyLo;
    out[at + 33] = zone.keyHi;
    out[at + 34] = zone.hasLoop ? 1 : 0;
    at += ZONE_BYTES;
  }
  out.set(new Uint8Array(bank.pcm.buffer, bank.pcm.byteOffset, bank.pcm.byteLength), at);
  return out;
}

export function decodeBank(bytes: Uint8Array): SampleBank | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (bytes[0] !== 77 || bytes[1] !== 86 || bytes[2] !== 76 || bytes[3] !== 83) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== 1) return null;
  const slotCount = view.getUint32(8, true);
  const zoneCount = view.getUint32(12, true);
  const pcmFrames = view.getUint32(16, true);
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (let i = 0; i < 5; i++) counts[i] = view.getUint32(20 + i * 4, true);
  const need = HEADER_BYTES + slotCount * SLOT_BYTES + zoneCount * ZONE_BYTES + pcmFrames * 2;
  if (bytes.length < need) return null;
  const slots: SampleSlot[] = [];
  let at = HEADER_BYTES;
  for (let i = 0; i < slotCount; i++) {
    slots.push({ zoneIndex: view.getUint32(at, true), zoneCount: view.getUint16(at + 4, true) });
    at += SLOT_BYTES;
  }
  const zones: SampleZone[] = [];
  for (let i = 0; i < zoneCount; i++) {
    zones.push({
      offset: view.getUint32(at, true),
      length: view.getUint32(at + 4, true),
      loopStart: view.getUint32(at + 8, true),
      loopEnd: view.getUint32(at + 12, true),
      originalPitch: view.getFloat32(at + 16, true),
      coarseTune: view.getFloat32(at + 20, true),
      fineTune: view.getFloat32(at + 24, true),
      sampleRate: view.getFloat32(at + 28, true),
      keyLo: bytes[at + 32],
      keyHi: bytes[at + 33],
      hasLoop: bytes[at + 34] !== 0,
    });
    at += ZONE_BYTES;
  }
  const pcm = new Int16Array(pcmFrames);
  const raw = new Uint8Array(bytes.buffer, bytes.byteOffset + at, pcmFrames * 2);
  new Uint8Array(pcm.buffer).set(raw);
  return assembleBank(counts, slots, zones, pcm);
}

/** Strudel's zone test: low <= note and high + 1 >= note. Nearest range if none covers it. */
export function zoneForNote(bank: SampleBank, slotIndex: number, midi: number): number {
  const slot = bank.slots[slotIndex];
  if (!slot || slot.zoneCount < 1) return -1;
  let nearest = slot.zoneIndex;
  let best = 1e9;
  for (let i = 0; i < slot.zoneCount; i++) {
    const zone = bank.zones[slot.zoneIndex + i];
    if (!zone) continue;
    if (zone.keyLo <= midi && zone.keyHi + 1 >= midi) return slot.zoneIndex + i;
    const mid = (zone.keyLo + zone.keyHi) / 2;
    const dist = Math.abs(mid - midi);
    if (dist < best) {
      best = dist;
      nearest = slot.zoneIndex + i;
    }
  }
  return nearest;
}

/** Playback ratio. originalPitch is in the same cents Strudel's font loader uses. */
export function gmRatio(zone: SampleZone, midi: number): number {
  const base = zone.originalPitch - 100 * zone.coarseTune - zone.fineTune;
  return 2 ** ((100 * midi - base) / 1200);
}

/** Drum pitch knob. 0.5 plays the recording as it was sampled, ±12 semitones either way. */
export function drumRatio(pitch: number): number {
  const unit = pitch < 0 ? 0 : pitch > 1 ? 1 : pitch;
  return 2 ** (((unit - 0.5) * 24) / 12);
}

export function frameInc(zone: SampleZone, ratio: number, outputRate: number): number {
  const source = zone.sampleRate > 1 ? zone.sampleRate : outputRate;
  return ratio * source / outputRate;
}

/** Linear read. Advances `pos` by `inc`, wrapping a loop when the zone has one. */
export function readFrame(bank: SampleBank, zoneIndex: number, pos: number, inc: number): { value: number; pos: number } {
  const zone = bank.zones[zoneIndex];
  if (!zone) return { value: 0, pos };
  let nextPos = pos + inc;
  if (zone.hasLoop && zone.loopEnd > zone.loopStart) {
    const span = zone.loopEnd - zone.loopStart;
    if (span > 0 && nextPos >= zone.loopEnd) nextPos = zone.loopStart + ((nextPos - zone.loopStart) % span);
  } else if (nextPos > zone.length) nextPos = zone.length;
  if (pos < 0 || pos >= zone.length) return { value: 0, pos: nextPos };
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = (bank.pcm[zone.offset + i] ?? 0) / 32768;
  const next = i + 1 < zone.length ? (bank.pcm[zone.offset + i + 1] ?? 0) / 32768 : a;
  return { value: a + (next - a) * frac, pos: nextPos };
}

export interface ResolvedSample {
  zone: number;
  ratio: number;
}

/** Null keeps the procedural voice: index 0, a missing bank, or a slot without a zone. */
export function resolveSample(bank: SampleBank | null, lane: number, unit: number, midi: number, pitched: boolean, pitchUnit: number): ResolvedSample | null {
  if (!bank) return null;
  const catalog = sampleCatalogIndex(lane);
  const count = bank.counts[catalog] ?? 0;
  const index = Math.round((unit < 0 ? 0 : unit > 1 ? 1 : unit) * count);
  if (index <= 0 || index > count) return null;
  const slot = bank.starts[catalog] + index - 1;
  const zone = zoneForNote(bank, slot, pitched ? midi : 60);
  if (zone < 0) return null;
  const found = bank.zones[zone];
  if (!found) return null;
  return { zone, ratio: pitched ? gmRatio(found, midi) : drumRatio(pitchUnit) };
}
