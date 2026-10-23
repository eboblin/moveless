import { DIGIT_H, DIGIT_W, plotDigit } from "./digits.ts";

/** Gap between two glyphs. A space is its own advance and does not add this gap. */
export const LETTER_GAP = 1;
export const SPACE_W = 3;

/**
 * Bold 6×11 capitals, same cell as the param digits.
 * Each row is a 6-bit mask, MSB on the left.
 */
/** Two-pixel slash, same cell as the capitals. */
const SLASH: readonly number[] = [
  0b000011, 0b000011, 0b000110, 0b000110, 0b001100, 0b001100, 0b011000, 0b011000, 0b110000, 0b110000, 0b110000,
];

const LETTERS: readonly (readonly number[])[] = [
  // A
  [0b011110, 0b111111, 0b110011, 0b110011, 0b111111, 0b111111, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011],
  // B
  [0b111110, 0b111111, 0b110011, 0b110011, 0b111110, 0b111110, 0b110011, 0b110011, 0b110011, 0b111111, 0b111110],
  // C
  [0b011110, 0b111111, 0b110011, 0b110000, 0b110000, 0b110000, 0b110000, 0b110000, 0b110011, 0b111111, 0b011110],
  // D
  [0b111110, 0b111111, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b111111, 0b111110],
  // E
  [0b111111, 0b111111, 0b110000, 0b110000, 0b111110, 0b111110, 0b110000, 0b110000, 0b110000, 0b111111, 0b111111],
  // F
  [0b111111, 0b111111, 0b110000, 0b110000, 0b111110, 0b111110, 0b110000, 0b110000, 0b110000, 0b110000, 0b110000],
  // G
  [0b011110, 0b111111, 0b110011, 0b110000, 0b110000, 0b110111, 0b110011, 0b110011, 0b110011, 0b111111, 0b011111],
  // H
  [0b110011, 0b110011, 0b110011, 0b110011, 0b111111, 0b111111, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011],
  // I
  [0b111111, 0b111111, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b111111, 0b111111],
  // J
  [0b001111, 0b001111, 0b000011, 0b000011, 0b000011, 0b000011, 0b000011, 0b110011, 0b110011, 0b111111, 0b011110],
  // K
  [0b110011, 0b110011, 0b110110, 0b111100, 0b111000, 0b111100, 0b110110, 0b110011, 0b110011, 0b110011, 0b110011],
  // L
  [0b110000, 0b110000, 0b110000, 0b110000, 0b110000, 0b110000, 0b110000, 0b110000, 0b110000, 0b111111, 0b111111],
  // M
  [0b110011, 0b111111, 0b111111, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011],
  // N
  [0b110011, 0b111011, 0b111011, 0b111111, 0b110111, 0b110111, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011],
  // O
  [0b011110, 0b111111, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b111111, 0b011110],
  // P
  [0b111110, 0b111111, 0b110011, 0b110011, 0b110011, 0b111111, 0b111110, 0b110000, 0b110000, 0b110000, 0b110000],
  // Q
  [0b011110, 0b111111, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110111, 0b111111, 0b011111, 0b000110],
  // R
  [0b111110, 0b111111, 0b110011, 0b110011, 0b111111, 0b111110, 0b110110, 0b110011, 0b110011, 0b110011, 0b110011],
  // S
  [0b011110, 0b111111, 0b110011, 0b110000, 0b111110, 0b111111, 0b000011, 0b000011, 0b110011, 0b111111, 0b011110],
  // T
  [0b111111, 0b111111, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100],
  // U
  [0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b111111, 0b011110],
  // V
  [0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b011110, 0b011110, 0b001100, 0b001100],
  // W
  [0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b111111, 0b111111, 0b111111, 0b110011, 0b110011],
  // X
  [0b110011, 0b110011, 0b110011, 0b011110, 0b001100, 0b001100, 0b011110, 0b110011, 0b110011, 0b110011, 0b110011],
  // Y
  [0b110011, 0b110011, 0b110011, 0b011110, 0b011110, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100],
  // Z
  [0b111111, 0b111111, 0b000011, 0b000110, 0b001100, 0b001100, 0b011000, 0b110000, 0b110000, 0b111111, 0b111111],
];

type Glyph = "space" | "digit" | readonly number[];

function glyphOf(ch: string): Glyph | null {
  if (ch === " ") return "space";
  if (ch === "/") return SLASH;
  if (ch >= "0" && ch <= "9") return "digit";
  const index = ch.charCodeAt(0) - 65;
  if (index < 0 || index >= LETTERS.length) return null;
  return LETTERS[index] ?? null;
}

/** Width of a title line. Letters and digits are 6 px, the gap between them is 1, a space is 3. */
export function lettersWidth(text: string): number {
  let width = 0;
  let gap = false;
  for (const ch of text.toUpperCase()) {
    const glyph = glyphOf(ch);
    if (glyph === null) continue;
    if (glyph === "space") {
      width += SPACE_W;
      gap = false;
      continue;
    }
    if (gap) width += LETTER_GAP;
    width += DIGIT_W;
    gap = true;
  }
  return width;
}

/** Plot a title. The caller clips to the screen. */
export function plotLetters(text: string, x: number, y: number, plot: (px: number, py: number) => void): void {
  let cursor = x;
  let gap = false;
  for (const ch of text.toUpperCase()) {
    const glyph = glyphOf(ch);
    if (glyph === null) continue;
    if (glyph === "space") {
      cursor += SPACE_W;
      gap = false;
      continue;
    }
    if (gap) cursor += LETTER_GAP;
    if (glyph === "digit") plotDigit(Number(ch), cursor, y, plot);
    else plotRows(glyph, cursor, y, plot);
    cursor += DIGIT_W;
    gap = true;
  }
}

function plotRows(rows: readonly number[], x: number, y: number, plot: (px: number, py: number) => void): void {
  for (let row = 0; row < DIGIT_H; row++) {
    const bits = rows[row] ?? 0;
    for (let col = 0; col < DIGIT_W; col++) {
      if (bits & (1 << (DIGIT_W - 1 - col))) plot(x + col, y + row);
    }
  }
}
