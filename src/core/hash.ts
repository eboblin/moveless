/** Deterministic 0..1 mix. Scene id is intentionally not an input. */
export function hash01(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0xff;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
