export const DIGIT_W = 6;
export const DIGIT_H = 11;
/** Gap between tens and ones. */
export const DIGIT_PAIR_GAP = 1;

/**
 * Bold 6×11 digit bitmaps. Each row is a 6-bit mask (MSB = left pixel).
 * Designed to read on a 128×64 OLED inside a 16 px param cell.
 */
const GLYPHS: readonly (readonly number[])[] = [
  // 0
  [0b011110, 0b111111, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b111111, 0b011110],
  // 1
  [0b001100, 0b011100, 0b111100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b111111, 0b111111],
  // 2
  [0b011110, 0b111111, 0b110011, 0b000011, 0b000111, 0b001110, 0b011100, 0b111000, 0b110000, 0b111111, 0b111111],
  // 3
  [0b011110, 0b111111, 0b110011, 0b000011, 0b001111, 0b001111, 0b000011, 0b110011, 0b110011, 0b111111, 0b011110],
  // 4
  [0b000110, 0b001110, 0b011110, 0b110110, 0b110110, 0b110110, 0b111111, 0b111111, 0b000110, 0b000110, 0b000110],
  // 5
  [0b111111, 0b111111, 0b110000, 0b110000, 0b111110, 0b111111, 0b000011, 0b000011, 0b110011, 0b111111, 0b011110],
  // 6
  [0b011110, 0b111111, 0b110011, 0b110000, 0b111110, 0b111111, 0b110011, 0b110011, 0b110011, 0b111111, 0b011110],
  // 7
  [0b111111, 0b111111, 0b000011, 0b000110, 0b000110, 0b001100, 0b001100, 0b011000, 0b011000, 0b011000, 0b011000],
  // 8
  [0b011110, 0b111111, 0b110011, 0b110011, 0b011110, 0b011110, 0b110011, 0b110011, 0b110011, 0b111111, 0b011110],
  // 9
  [0b011110, 0b111111, 0b110011, 0b110011, 0b110011, 0b111111, 0b011111, 0b000011, 0b110011, 0b111111, 0b011110],
];

/** Big bold glyphs when the natural amount fits in 0..99. */
export interface BigAmount {
  kind: "big";
  n: number;
  negative: boolean;
}

/**
 * Host 4×5 print when the natural amount needs 3+ digits (no 0..99 squash).
 * `text` is digits only; minus is drawn above like big amounts.
 */
export interface WideAmount {
  kind: "wide";
  text: string;
  negative: boolean;
}

/** Division. The cell prints both numbers in the ordinary small face, one floor each. */
export interface FractionAmount {
  kind: "fraction";
  num: number;
  den: number;
  triplet: boolean;
}

export type DisplayAmount = BigAmount | WideAmount | FractionAmount;

/** The three fields a value cell needs from a knob. */
interface AmountRange {
  min: number;
  max: number;
  integer: boolean;
}

/** Same units as the old value label: integers as-is, floats as centi (×100). */
export function naturalAmount(value: number, binding: AmountRange): number {
  return binding.integer ? Math.round(value) : Math.round(value * 100);
}

/**
 * Big digits for 0..99; otherwise small-font text (true natural value, no scaling).
 * Bipolar keeps abs digits/text and a minus flag above the glyph.
 */
export function displayAmount(value: number, binding: AmountRange): BigAmount | WideAmount {
  const bipolar = binding.min < 0 && binding.max > 0;
  const negative = bipolar && value < 0;
  const natural = Math.abs(naturalAmount(value, binding));
  if (natural <= 99) return { kind: "big", n: natural, negative };
  return { kind: "wide", text: String(natural), negative };
}

export function digitBlockWidth(n: number): number {
  return n < 10 ? DIGIT_W : DIGIT_W * 2 + DIGIT_PAIR_GAP;
}

/** Plot one 0–9 glyph; returns advance width. */
export function plotDigit(d: number, x: number, y: number, plot: (px: number, py: number) => void): void {
  const glyph = GLYPHS[Math.max(0, Math.min(9, d | 0))];
  for (let row = 0; row < DIGIT_H; row++) {
    const bits = glyph[row];
    for (let col = 0; col < DIGIT_W; col++) {
      if (bits & (1 << (DIGIT_W - 1 - col))) plot(x + col, y + row);
    }
  }
}

/** Centered big amount in a fixed-width cell; optional minus dash above. */
export function plotAmount(
  cellLeft: number,
  cellW: number,
  digitY: number,
  amount: BigAmount,
  plot: (px: number, py: number) => void,
): void {
  const width = digitBlockWidth(amount.n);
  let x = cellLeft + Math.max(0, Math.floor((cellW - width) / 2));
  if (amount.n >= 10) {
    plotDigit(Math.floor(amount.n / 10), x, digitY, plot);
    x += DIGIT_W + DIGIT_PAIR_GAP;
  }
  plotDigit(amount.n % 10, x, digitY, plot);
  if (amount.negative) plotMinus(cellLeft, cellW, digitY, plot);
}

/** `1/16` and `1/16T`. Anything else is not a division label. */
export function fractionFromLabel(text: string): FractionAmount | null {
  const match = /^(\d+)\/(\d+)(T)?$/.exec(text);
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (num > 99 || den > 99) return null;
  return { kind: "fraction", num, den, triplet: match[3] === "T" };
}

/** `1/x` is the denominator alone. The title keeps the full fraction, including a triplet. */
export function divisionCell(text: string): BigAmount | FractionAmount | null {
  const fraction = fractionFromLabel(text);
  if (!fraction) return null;
  if (fraction.num === 1) return { kind: "big", n: fraction.den, negative: false };
  return fraction;
}

/** Short dash centered above the digit block. */
export function plotMinus(
  cellLeft: number,
  cellW: number,
  digitY: number,
  plot: (px: number, py: number) => void,
): void {
  const mid = cellLeft + Math.floor(cellW / 2);
  const my = digitY - 2;
  for (let dx = -1; dx <= 1; dx++) plot(mid + dx, my);
}
