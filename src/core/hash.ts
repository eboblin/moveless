/** Deterministic 0..1 mix. Scene id is intentionally not an input. */
export function hash01(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const part of parts) {
    if (typeof part === "number" && Number.isFinite(part)) {
      // Mix the numeric bits directly so nearby step indices do not share a threshold.
      h ^= part | 0;
      h = Math.imul(h, 16777619);
      h ^= (Math.floor(part) >>> 16) & 0xffff;
      h = Math.imul(h, 16777619);
    } else {
      const text = String(part);
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
    }
    h ^= 0xff;
    h = Math.imul(h, 16777619);
  }
  // Avalanche: without this, short/near inputs cluster and probability feels binary.
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
