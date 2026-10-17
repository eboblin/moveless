export const MOTIF_COUNT = 64;
export const MOTIF_BANK_VERSION = 1;

/** One cycle of a stored shape. Phase 0..1 maps to -1..1. Id is the only coordinate. */
export function motif(id: number, phase01: number): number {
  const index = mod(Math.round(id), MOTIF_COUNT);
  const phase = phase01 - Math.floor(phase01);
  const kind = index % 8;
  const variant = 1 + Math.floor(index / 8);
  let sample = 0;
  switch (kind) {
    case 0:
      sample = Math.sin(2 * Math.PI * variant * phase);
      break;
    case 1:
      sample = 2 * ((variant * phase) % 1) - 1;
      break;
    case 2:
      sample = (variant * phase) % 1 < 0.5 ? 1 : -1;
      break;
    case 3: {
      const x = (variant * phase) % 1;
      sample = x < 0.5 ? 4 * x - 1 : 3 - 4 * x;
      break;
    }
    case 4: {
      const steps = variant + 1;
      const q = Math.floor(phase * steps) / steps;
      sample = Math.sin(2 * Math.PI * (1 + (variant % 3)) * q);
      break;
    }
    case 5: {
      const peaks = variant;
      const x = (peaks * phase) % 1;
      sample = 1 - 4 * Math.abs(x - 0.5);
      break;
    }
    case 6:
      sample = euclidGate(4 + variant, 1 + (variant % 5), phase);
      break;
    default: {
      const x = Math.floor(phase * (4 + variant));
      sample = x % (1 + (variant % 3)) === 0 ? 1 : -0.35;
      break;
    }
  }
  if (sample > 1) return 1;
  if (sample < -1) return -1;
  return sample;
}

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function euclidGate(steps: number, pulses: number, phase: number): number {
  const idx = Math.floor(phase * steps) % steps;
  const hits = Math.max(1, Math.min(pulses, steps));
  for (let p = 0; p < hits; p++) {
    if (Math.floor((p * steps) / hits) === idx) return 1;
  }
  return -1;
}
