import { SAMPLE_RATE } from "./clock.ts";

/**
 * Beat-synced deck gestures. The read head is a pure function of musical time,
 * so a brake can be checked without rendering audio. The ring in the voice
 * turns these positions into samples.
 */

export const DECK_GESTURES = [
  "roll",
  "stut",
  "loop",
  "rev",
  "jump",
  "glch",
  "tran",
  "drop",
  "half",
  "dbl",
  "stop",
  "spin",
  "back",
  "scr",
  "hlx",
  "thrw",
] as const;

export const DECK_GROUPS = ["rpt", "lop", "glc", "scr", "gat", "pch", "stp", "thr"] as const;

export type DeckGroup = (typeof DECK_GROUPS)[number];

/** A legacy name, or a group plus its row: `glc0` is shuffle, `glc3` is cut. */
export type DeckGesture = (typeof DECK_GESTURES)[number] | `${DeckGroup}${0 | 1 | 2 | 3}`;

/** Left two columns, top to bottom. The other thirty-two minus these are the variation field. */
export const GROUP_PAD: readonly { id: DeckGroup; index: number; code: string; title: string; hue: number }[] = [
  { id: "rpt", index: 24, code: "RPT", title: "BEAT REPEAT", hue: 3 },
  { id: "lop", index: 16, code: "LOP", title: "LOOP", hue: 9 },
  { id: "glc", index: 8, code: "GLC", title: "GLITCH", hue: 13 },
  { id: "scr", index: 0, code: "SCR", title: "SCRATCH", hue: 1 },
  { id: "gat", index: 25, code: "GAT", title: "TRANSFORM", hue: 18 },
  { id: "pch", index: 17, code: "PCH", title: "PITCH", hue: 21 },
  { id: "stp", index: 9, code: "STP", title: "BRAKE", hue: 25 },
  { id: "thr", index: 1, code: "THR", title: "DELAY THROW", hue: 8 },
];

export interface DeckCell {
  /** 0 is the small left column, 5 is the large right column. */
  x: number;
  /** 0 is the plain bottom row, 3 is the strong top row. */
  y: number;
}

export interface DeckKnobs {
  /** Index into {@link DIV_BEATS}. */
  div: number;
  /** 0 is one sixteenth, 1 is a bar. */
  len: number;
  /** 0 leaves the master alone, 1 is the whole gesture. */
  depth: number;
  /** Index into the brake table. On scratch, the crossfader column. */
  brake: number;
  /** Scratch throw. 0 is a tight hand, 1 crosses the whole window. */
  vary: number;
  /** When the gesture grabs the grid: now, division, beat, bar. */
  quant: number;
  /** Transform width, or how hard a scratch fader cuts. */
  duty: number;
  /** Pitch bend. On scratch, centre is the written hand: left reverses, right leans into the push. */
  ramp: number;
  /** DJ filter. 0.5 is dry, below is high-pass, above is low-pass. */
  filter: number;
  /** Resonance on that filter. 0 is the gentle corner. */
  resonance: number;
  /** Saturation after the filter. 0 leaves the sample alone. */
  drive: number;
  /** Isolator low. 0.5 is unity, 0 kills the band, 1 is about +6 dB. */
  low: number;
  /** Isolator mid. Same law as {@link DeckKnobs.low}. */
  mid: number;
  /** Isolator high. Same law as {@link DeckKnobs.low}. */
  high: number;
  /** Remembered field cell for each {@link DECK_GROUPS} entry. */
  cells: DeckCell[];
  /** Group whose cell the knobs are showing. */
  focus: number;
}

/** Sixteenth, eighth, quarter, half, whole, two bars. Left of the field is the short one. */
export const DIV_BEATS = [0.125, 0.25, 0.5, 1, 2, 4] as const;
export const DIV_LABEL = ["1/32", "1/16", "1/8", "1/4", "1/2", "1/1"] as const;
/** Cell text. The column fits three characters, so 1/32 and 1/16 drop the leading 1. */
const DIV_SHORT = ["/32", "/16", "1/8", "1/4", "1/2", "1/1"] as const;
/** Shortest brake first. Index 4 is one beat, the old factory stop. */
export const BRAKE_BEATS = [0.0625, 0.125, 0.25, 0.5, 1, 2] as const;
export const BRAKE_LABEL = ["1/16", "1/8", "1/4", "1/2", "1/1", "2/1"] as const;
const BRAKE_SHORT = ["/16", "1/8", "1/4", "1/2", "1/1", "2/1"] as const;
export const PITCH_RATE = [0.5, 0.75, 1, 1.5, 2, 4] as const;
const LEN_STEPS = [1, 2, 4, 8, 12, 16] as const;
export const QUANT_LABEL = ["NOW", "DIV", "BEAT", "BAR"] as const;
const QUANT_SHORT = ["NOW", "DIV", "BEA", "BAR"] as const;
/** Phrase length in sixteenths. The column picks one. Each is a sum of 1, 2 and 3. */
const SCRATCH_DUR = [2, 4, 6, 8, 12, 16] as const;
/** Speed bag per complexity. Duplicates are the odds: simple stays near 2, wild leans on 1. */
const SCRATCH_SPEED: readonly (readonly number[])[] = [
  [2, 2, 2, 1],
  [2, 2, 1, 1],
  [2, 1, 3, 1],
  [1, 1, 2, 3],
];
export const PHRASE_LABEL = ["1/8", "1/4", "3/8", "1/2", "3/4", "1/1"] as const;
const PHRASE_WORD = ["EIGHTH", "BEAT", "DOT", "HALF", "3/4", "BAR"] as const;

const FACTORY_CELLS: readonly DeckCell[] = [
  { x: 2, y: 0 },
  { x: 3, y: 0 },
  { x: 2, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 0 },
  { x: 4, y: 0 },
  { x: 3, y: 0 },
];

/** 8 ms. Release slips back to the live head across this. */
export const DECK_FADE = Math.round(0.008 * SAMPLE_RATE);

export type DeckKnobId = "div" | "len" | "depth" | "brake" | "vary" | "quant" | "duty" | "ramp";

/** Tone strip. These stay off the focused group's cell. */
export type DeckToneId = "filter" | "resonance" | "drive" | "low" | "mid" | "high";

/** A cell axis that is not one of the eight shared numbers. Pitch rate and throw length stay off DIV. */
export type DeckSlot = DeckKnobId | DeckToneId | "row" | "rate" | "open";

const SLOT_IDS: readonly DeckSlot[] = [
  "div", "len", "depth", "brake", "vary", "quant", "duty", "ramp",
  "row", "rate", "open",
  "filter", "resonance", "drive", "low", "mid", "high",
];

/**
 * Knobs left of the fixed trio. The field column — a division, a window, a
 * fader, a brake or a tape speed — sits on one encoder, quant beside it, depth last.
 * Stop ignores the grid, so its quant column stays empty.
 */
const GROUP_SLOTS: Record<DeckGroup, readonly DeckSlot[]> = {
  rpt: ["row"],
  lop: ["row"],
  glc: ["row"],
  scr: ["row", "len", "vary", "duty", "ramp"],
  gat: ["row", "duty"],
  pch: ["row", "ramp"],
  stp: ["row"],
  thr: ["row"],
};

/** The X column. Division, loop length, scratch phrase, transform division, tape speed, brake time, or throw open. */
const COLUMN_SLOT: Record<DeckGroup, DeckSlot> = {
  rpt: "div",
  lop: "len",
  glc: "div",
  scr: "brake",
  gat: "div",
  pch: "rate",
  stp: "brake",
  thr: "open",
};

/** Short name under the row knob. The value itself is the variant name. */
export function rowKnobName(group: DeckGroup): string {
  switch (group) {
    case "glc":
      return "PAT";
    case "scr":
      return "CMP";
    case "gat":
      return "TRN";
    case "pch":
    case "stp":
      return "SHP";
    case "thr":
      return "SND";
    default:
      return "WAY";
  }
}

/** Scratch renames the shared knobs. Other groups keep the face label. */
export function slotKnobName(group: DeckGroup, slot: DeckSlot): string | null {
  if (group !== "scr") return null;
  switch (slot) {
    case "row":
      return "CMP";
    case "len":
      return "CUE";
    case "vary":
      return "THR";
    case "duty":
      return "CUT";
    case "ramp":
      return "DIR";
    case "brake":
      return "DUR";
    default:
      return null;
  }
}

/** Three characters, the width of one encoder cell. */
const ROW_TEXT: Record<DeckGroup, readonly string[]> = {
  rpt: ["RPT", "JMP", "REV", "PNG"],
  lop: ["FWD", "REV", "PNG", "STP"],
  glc: ["SHF", "JMP", "MNG", "CUT"],
  scr: ["SGL", "DUO", "MIX", "WLD"],
  gat: ["HLF", "NAR", "MUT", "AND"],
  pch: ["HLD", "RIS", "FAL", "WOB"],
  stp: ["STP", "SPN", "BCK", "BNC"],
  thr: ["SFT", "EVN", "TAL", "HOT"],
};

const ROW_WORD: Record<DeckGroup, readonly string[]> = {
  rpt: ["REPEAT", "JUMP", "REVERSE", "PONG"],
  lop: ["FORWARD", "REVERSE", "PONG", "STEP"],
  glc: ["SHUFFLE", "JUMP", "MANGLE", "CUT"],
  scr: ["SINGLE", "DUO", "MIXED", "WILD"],
  gat: ["HALF", "NARROW", "MUTE", "OFFBEAT"],
  pch: ["HOLD", "RISE", "FALL", "WOBBLE"],
  stp: ["STOP", "SPIN", "BACK", "BOUNCE"],
  thr: ["SOFT", "EVEN", "TAIL", "HOT"],
};

/** Tape speed of the pitch column. Middle step is ×1. */
export const RATE_LABEL = ["1/2", "3/4", "x1", "3/2", "x2", "x4"] as const;

export function rowValueLabel(group: DeckGroup, y: number): string {
  return ROW_TEXT[group][pick(y, 4)] ?? "RPT";
}

/** Spoken row name for the header. The cell uses {@link rowValueLabel}. */
export function rowValueWord(group: DeckGroup, y: number): string {
  return ROW_WORD[group][pick(y, 4)] ?? "REPEAT";
}

export function divShort(index: number): string {
  return DIV_SHORT[pick(index, DIV_SHORT.length)] ?? "1/8";
}

export function brakeShort(index: number): string {
  return BRAKE_SHORT[pick(index, BRAKE_SHORT.length)] ?? "1/1";
}

export function quantShort(index: number): string {
  return QUANT_SHORT[pick(index, QUANT_SHORT.length)] ?? "BAR";
}

export function phraseShort(index: number): string {
  return PHRASE_LABEL[pick(index, PHRASE_LABEL.length)] ?? "1/8";
}

export function phraseWord(index: number): string {
  return PHRASE_WORD[pick(index, PHRASE_WORD.length)] ?? "EIGHTH";
}

/** Sixteenths the needle sits behind the note. The middle of the knob is on the note. */
export function scratchCue(len: number): number {
  const unit = Math.max(0, Math.min(1, len));
  return Math.round(Math.abs(unit - 0.5) * 8);
}

export function isDeckSlot(id: string): id is DeckSlot {
  return (SLOT_IDS as readonly string[]).includes(id);
}

export function focusedGroup(deck: DeckKnobs): DeckGroup {
  return DECK_GROUPS[pick(deck.focus, DECK_GROUPS.length)] ?? "rpt";
}

/** Eight encoder columns. Division, quant and depth stay on the right. Null is an empty encoder. */
export function deckSlots(group: DeckGroup, knobs: DeckKnobs): (DeckSlot | null)[] {
  const left = [...GROUP_SLOTS[group]];
  const column = COLUMN_SLOT[group];
  const usesQuant = group !== "stp";
  const quantIsDiv = usesQuant && pick(knobs.quant, 4) === 1;
  const columnIsDiv = column === "div" || column === "rate" || column === "open";
  if (quantIsDiv && !columnIsDiv && !left.includes("div") && left.length < 5) left.push("div");
  const slots: (DeckSlot | null)[] = [null, null, null, null, null, null, null, null];
  left.forEach((id, index) => {
    if (index < 5) slots[index] = id;
  });
  slots[5] = column;
  if (usesQuant) slots[6] = "quant";
  slots[7] = "depth";
  return slots;
}

export function readDeckSlot(deck: DeckKnobs, id: DeckSlot): number {
  const cell = cellOf(deck, focusedGroup(deck));
  if (id === "row") return cell.y;
  if (id === "rate" || id === "open") return cell.x;
  return deck[id];
}

export function defaultDeck(): DeckKnobs {
  return {
    div: 2,
    len: 0.5,
    depth: 1,
    brake: 4,
    vary: 0.25,
    quant: 2,
    duty: 0.5,
    ramp: 0.5,
    filter: 0.5,
    resonance: 0,
    drive: 0,
    low: 0.5,
    mid: 0.5,
    high: 0.5,
    cells: FACTORY_CELLS.map((cell) => ({ ...cell })),
    focus: 0,
  };
}

/** Factory knobs and field. The group on screen stays. */
export function resetDeckKnobs(deck: DeckKnobs): DeckKnobs {
  const home = defaultDeck();
  if (
    deck.div === home.div &&
    deck.len === home.len &&
    deck.depth === home.depth &&
    deck.brake === home.brake &&
    deck.vary === home.vary &&
    deck.quant === home.quant &&
    deck.duty === home.duty &&
    deck.ramp === home.ramp &&
    deck.filter === home.filter &&
    deck.resonance === home.resonance &&
    deck.drive === home.drive &&
    deck.low === home.low &&
    deck.mid === home.mid &&
    deck.high === home.high &&
    deck.cells.length === home.cells.length &&
    deck.cells.every((cell, index) => cell.x === home.cells[index]?.x && cell.y === home.cells[index]?.y)
  ) {
    return deck;
  }
  return { ...home, cells: home.cells, focus: deck.focus };
}

export function isDeckGroup(value: string): value is DeckGroup {
  return (DECK_GROUPS as readonly string[]).includes(value);
}

export function isDeckGesture(value: string): value is DeckGesture {
  if ((DECK_GESTURES as readonly string[]).includes(value)) return true;
  return parseGroupGesture(value) !== null;
}

export function groupAt(index: number): DeckGroup | null {
  return GROUP_PAD.find((pad) => pad.index === index)?.id ?? null;
}

/** Variation field. Column 2 is X 0, the bottom row is Y 0. */
export function fieldAt(index: number): DeckCell | null {
  const col = index % 8;
  if (col < 2) return null;
  return { x: col - 2, y: Math.floor(index / 8) };
}

export function groupIndex(group: DeckGroup): number {
  return DECK_GROUPS.indexOf(group);
}

function cellOf(deck: DeckKnobs, group: DeckGroup): DeckCell {
  const cell = deck.cells[groupIndex(group)] ?? FACTORY_CELLS[groupIndex(group)];
  return { x: pick(cell?.x ?? 0, 6), y: pick(cell?.y ?? 0, 4) };
}

function copyCells(cells: DeckCell[]): DeckCell[] {
  return cells.map((cell) => ({ x: cell.x, y: cell.y }));
}

/** Sixteenth count the loop column stands for, as the LEN knob's 0..1. */
export function lenUnit(column: number, barBeats: number): number {
  const sixteenths = Math.max(1, Math.round(barBeats) * 4);
  const n = Math.min(sixteenths, LEN_STEPS[pick(column, LEN_STEPS.length)]);
  if (n >= sixteenths) return 1;
  return (n - 1) / sixteenths;
}

export function lenColumn(len: number, barBeats: number): number {
  const sixteenths = Math.max(1, Math.round(barBeats) * 4);
  const unit = Math.max(0, Math.min(1, len));
  const n = 1 + Math.min(sixteenths - 1, Math.floor(unit * sixteenths));
  let best = 0;
  let dist = Number.POSITIVE_INFINITY;
  LEN_STEPS.forEach((step, index) => {
    const delta = Math.abs(Math.min(sixteenths, step) - n);
    if (delta < dist) {
      dist = delta;
      best = index;
    }
  });
  return best;
}

function ownsDiv(group: DeckGroup): boolean {
  return group === "rpt" || group === "glc" || group === "gat";
}

function ownsBrake(group: DeckGroup): boolean {
  return group === "stp" || group === "scr";
}

/** Knobs the voice hears for this group. Pitch rate and throw length ride in `div`. */
export function assembleDeck(deck: DeckKnobs, group: DeckGroup, barBeats: number): DeckKnobs {
  const cell = cellOf(deck, group);
  const next = { ...deck, cells: deck.cells };
  if (ownsDiv(group) || group === "pch" || group === "thr") next.div = cell.x;
  if (group === "lop") next.len = lenUnit(cell.x, barBeats);
  if (ownsBrake(group)) next.brake = cell.x;
  return next;
}

export function behaviorOf(deck: DeckKnobs, group: DeckGroup): DeckGesture {
  return `${group}${cellOf(deck, group).y}` as DeckGesture;
}

/** Load the group's column into the shared knob it owns. Pitch rate and throw length stay on the cell. */
export function recallGroup(deck: DeckKnobs, group: DeckGroup, barBeats: number): DeckKnobs {
  const cells = copyCells(deck.cells.length === 8 ? deck.cells : defaultDeck().cells);
  const next: DeckKnobs = { ...deck, cells, focus: groupIndex(group) };
  const cell = cellOf(next, group);
  if (ownsDiv(group)) next.div = cell.x;
  if (group === "lop") next.len = lenUnit(cell.x, barBeats);
  if (ownsBrake(group)) next.brake = cell.x;
  return next;
}

/** Remember a field press on the focused group and show that column on its knob. */
export function setGroupCell(deck: DeckKnobs, group: DeckGroup, x: number, y: number, barBeats: number): DeckKnobs {
  const cells = copyCells(deck.cells.length === 8 ? deck.cells : defaultDeck().cells);
  cells[groupIndex(group)] = { x: pick(x, 6), y: pick(y, 4) };
  return recallGroup({ ...deck, cells }, group, barBeats);
}

/** After a randomize, the focused group keeps the column its knob just landed on. */
export function stickDeckFocus(deck: DeckKnobs, barBeats: number): DeckKnobs {
  const group = DECK_GROUPS[pick(deck.focus, DECK_GROUPS.length)] ?? "rpt";
  let next = deck;
  if (ownsDiv(group)) next = writeDeckKnob(next, "div", next.div, barBeats);
  if (ownsBrake(group)) next = writeDeckKnob(next, "brake", next.brake, barBeats);
  if (group === "lop") next = writeDeckKnob(next, "len", next.len, barBeats);
  return next;
}

function isToneKnob(id: DeckSlot): id is DeckToneId {
  return id === "filter" || id === "resonance" || id === "drive" || id === "low" || id === "mid" || id === "high";
}

/** A knob turn writes the shared value, and the focused group's cell when that knob is its column or row. */
export function writeDeckKnob(deck: DeckKnobs, id: DeckSlot, value: number, barBeats: number): DeckKnobs {
  if (isToneKnob(id)) {
    const next = clamp01(value);
    if (deck[id] === next) return deck;
    return { ...deck, [id]: next };
  }
  const group = focusedGroup(deck);
  const index = groupIndex(group);
  const base = deck.cells.length === 8 ? deck.cells : defaultDeck().cells;
  const prev = base[index] ?? { x: 0, y: 0 };
  let x = prev.x;
  let y = prev.y;
  let div = deck.div;
  let len = deck.len;
  let depth = deck.depth;
  let brake = deck.brake;
  let vary = deck.vary;
  let quant = deck.quant;
  let duty = deck.duty;
  let ramp = deck.ramp;
  if (id === "div") div = value;
  else if (id === "len") len = value;
  else if (id === "depth") depth = value;
  else if (id === "brake") brake = value;
  else if (id === "vary") vary = value;
  else if (id === "quant") quant = value;
  else if (id === "duty") duty = value;
  else if (id === "ramp") ramp = value;
  if (id === "div" && ownsDiv(group)) x = pick(value, 6);
  if (id === "brake" && ownsBrake(group)) x = pick(value, 6);
  if (id === "len" && group === "lop") {
    x = lenColumn(value, barBeats);
    len = lenUnit(x, barBeats);
  }
  if (id === "row") y = pick(value, 4);
  if (id === "rate" && group === "pch") x = pick(value, 6);
  if (id === "open" && group === "thr") x = pick(value, 6);
  if (
    deck.cells.length === 8 &&
    prev.x === x &&
    prev.y === y &&
    deck.div === div &&
    deck.len === len &&
    deck.depth === depth &&
    deck.brake === brake &&
    deck.vary === vary &&
    deck.quant === quant &&
    deck.duty === duty &&
    deck.ramp === ramp
  ) {
    return deck;
  }
  const cells = copyCells(base);
  cells[index] = { x, y };
  return { ...deck, cells, div, len, depth, brake, vary, quant, duty, ramp };
}

/** Old files stored a 7-step division and a 4-step brake. Map them onto the field. */
export function migrateDeckIndex(kind: "div" | "brake", index: number): number {
  if (kind === "brake") return [2, 3, 4, 5][pick(index, 4)] ?? 4;
  const beats = [2, 1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125][pick(index, 7)] ?? 0.5;
  let best = 0;
  let dist = Number.POSITIVE_INFINITY;
  DIV_BEATS.forEach((beat, at) => {
    const delta = Math.abs(beat - beats);
    if (delta < dist) {
      dist = delta;
      best = at;
    }
  });
  return best;
}

function pick(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(value)));
}

function mod(n: number, m: number): number {
  if (m <= 1) return 0;
  const r = n % m;
  return r < 0 ? r + m : r;
}

export function samplesPerBeat(tempo: number): number {
  return (SAMPLE_RATE * 60) / Math.max(1, tempo);
}

export function divSamples(knobs: DeckKnobs, tempo: number): number {
  return Math.max(1, Math.round(DIV_BEATS[pick(knobs.div, DIV_BEATS.length)] * samplesPerBeat(tempo)));
}

/** One sixteenth up to one bar, in samples. */
export function lenSamples(knobs: DeckKnobs, tempo: number, barBeats: number): number {
  const sixteenths = Math.max(1, Math.round(barBeats) * 4);
  const unit = Math.max(0, Math.min(1, knobs.len));
  const n = 1 + Math.min(sixteenths - 1, Math.floor(unit * sixteenths));
  return Math.max(1, Math.round((n * samplesPerBeat(tempo)) / 4));
}

export function brakeSamples(knobs: DeckKnobs, tempo: number): number {
  return Math.max(1, Math.round(BRAKE_BEATS[pick(knobs.brake, BRAKE_BEATS.length)] * samplesPerBeat(tempo)));
}

export function barSamples(tempo: number, barBeats: number): number {
  return Math.max(1, Math.round(Math.max(1, barBeats) * samplesPerBeat(tempo)));
}

/** Grid the gesture waits for. Immediate is one sample, so the press itself is the boundary. */
export function quantSamples(knobs: DeckKnobs, tempo: number, barBeats: number): number {
  const which = pick(knobs.quant, 4);
  if (which === 0) return 1;
  if (which === 1) return divSamples(knobs, tempo);
  if (which === 2) return Math.max(1, Math.round(samplesPerBeat(tempo)));
  return barSamples(tempo, barBeats);
}

/** Next boundary at or after `sample`. The grid is counted from sample 0. */
export function snapUp(sample: number, unit: number): number {
  const u = Math.max(1, Math.round(unit));
  if (u <= 1) return sample;
  const m = mod(sample, u);
  return m === 0 ? sample : sample + (u - m);
}

export interface DeckRead {
  /** Absolute source position. Ignored while `live` is 1. */
  pos: number;
  /** 1 hears the sample just rendered. 0 hears `pos`. */
  live: number;
  gain: number;
  /** 1 also pours the dry master into the delay. */
  throw: number;
  rate: number;
}

export interface DeckMoment {
  gesture: DeckGesture | null;
  /** Sample the finger went down. The voice clock, not the UI tick. */
  down: number;
  /** Sample the finger came up. Null while the gesture is still held. */
  up: number | null;
  now: number;
  tempo: number;
  barBeats: number;
  knobs: DeckKnobs;
  /** Samples already rendered past `now`. 0 means the ring only holds the past. */
  ahead: number;
  seed: number;
  /** Pad press that started the gesture. Scratch rolls a new phrase from it. */
  press?: number;
}

function identity(now: number): DeckRead {
  return { pos: now, live: 1, gain: 1, throw: 0, rate: 1 };
}

function stopped(now: number): DeckRead {
  return { pos: now, live: 0, gain: 0, throw: 0, rate: 0 };
}

/** Unpowered platter. Rate is exponential and is gone by the end of the brake. */
function brakeRate(elapsed: number, span: number): number {
  if (elapsed >= span) return 0;
  const k = -Math.log(0.01) / span;
  return Math.exp(-k * Math.max(0, elapsed));
}

function brakePos(elapsed: number, span: number, origin: number): number {
  if (elapsed >= span) return origin + span / -Math.log(0.01);
  const k = -Math.log(0.01) / span;
  return origin + (1 - Math.exp(-k * Math.max(0, elapsed))) / k;
}

/**
 * Cubic from a parked head to the live head. Position and rate meet the
 * downbeat together, which a linear ramp from 0 to 1 cannot do.
 */
function spinAt(origin: number, now: number, target: number): DeckRead {
  const span = Math.max(1, target - origin);
  const u = Math.max(0, Math.min(1, (now - origin) / span));
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
  const h01 = -2 * u ** 3 + 3 * u ** 2;
  const h11 = u ** 3 - u ** 2;
  const pos = h00 * origin + h01 * target + h11 * span;
  const d00 = 6 * u ** 2 - 6 * u;
  const d01 = -6 * u ** 2 + 6 * u;
  const d11 = 3 * u ** 2 - 2 * u;
  const rate = (d00 * origin + d01 * target + d11 * span) / span;
  return { pos, live: 0, gain: 1, throw: 0, rate };
}

function nextDownbeat(origin: number, minSpan: number, bar: number): number {
  let target = snapUp(origin + 1, bar);
  if (target - origin < minSpan) target += bar;
  return target;
}

function glitchOrder(seed: number, barIndex: number, count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  let state = (Math.imul(seed + 1, 997) + Math.imul(barIndex + 1, 131)) >>> 0;
  for (let i = count - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order;
}

function loopPos(start: number, now: number, origin: number, slice: number): number {
  return start + mod(now - origin, slice);
}

/** Centre plays the hand as written. The left third reverses it; either side leans into that stroke. */
function scratchClock(phase: number, ramp: number): { phase: number; dir: number; dWarp: number } {
  const centered = clamp01(ramp) * 2 - 1;
  let dir = 1;
  let lean = centered * 2;
  if (centered < -0.5) {
    dir = -1;
    lean = (-centered - 0.5) / 0.5;
  }
  if (lean > 1) lean = 1;
  if (lean < -1) lean = -1;
  const exp = 1 + Math.abs(lean) * 1.35;
  const p = Math.max(0, Math.min(1, phase));
  if (p <= 0) return { phase: 0, dir, dWarp: 0 };
  if (p >= 1) return { phase: 1, dir, dWarp: exp };
  if (lean >= 0) return { phase: p ** exp, dir, dWarp: exp * p ** (exp - 1) };
  const q = 1 - p;
  return { phase: 1 - q ** exp, dir, dWarp: exp * q ** (exp - 1) };
}

const TEAR_P = [0, 0.18, 0.3, 0.5, 1];
const TEAR_V = [0, 0.7, 0.34, 1, 0];

/** Two pushes and a dip, then one return. Linear, so the corners stay the tear. */
function tearHand(phase: number): { pos: number; dpos: number } {
  let i = 0;
  while (i < TEAR_P.length - 2 && phase >= TEAR_P[i + 1]) i++;
  const p0 = TEAR_P[i] ?? 0;
  const p1 = TEAR_P[i + 1] ?? 1;
  const v0 = TEAR_V[i] ?? 0;
  const v1 = TEAR_V[i + 1] ?? 0;
  const span = p1 - p0;
  const t = span <= 0 ? 0 : (phase - p0) / span;
  return { pos: v0 + (v1 - v0) * t, dpos: span <= 0 ? 0 : (v1 - v0) / span };
}

/** Slow rewind, then a quick release back to the cue. */
function dragHand(phase: number): { pos: number; dpos: number } {
  if (phase < 0.8) {
    const t = phase / 0.8;
    const slope = -(0.5 * Math.PI * Math.sin(Math.PI * t)) / 0.8;
    return { pos: -(0.5 - 0.5 * Math.cos(Math.PI * t)), dpos: slope };
  }
  const t = (phase - 0.8) / 0.2;
  const slope = (0.5 * Math.PI * Math.sin(Math.PI * t)) / 0.2;
  return { pos: -(1 - (0.5 - 0.5 * Math.cos(Math.PI * t))), dpos: slope };
}

/** Record hand, normalised. Baby is one push, tear dips, drag rewinds, orbit circles the cue. */
function scratchHand(shape: number, phase: number): { pos: number; dpos: number } {
  const which = pick(shape, 4);
  if (which === 1) return tearHand(phase);
  if (which === 2) return dragHand(phase);
  if (which === 3) return { pos: Math.sin(2 * Math.PI * phase), dpos: 2 * Math.PI * Math.cos(2 * Math.PI * phase) };
  return { pos: Math.sin(Math.PI * phase), dpos: Math.PI * Math.cos(Math.PI * phase) };
}

/** `local` is 0..1 inside the current stroke. Orbit alternates out and back every quarter. */
function scratchStroke(shape: number, phase: number): { note: boolean; local: number } {
  const which = pick(shape, 4);
  if (which === 3) {
    const q = Math.max(0, Math.min(3, Math.floor(phase * 4)));
    return { note: q % 2 === 0, local: (phase - q * 0.25) / 0.25 };
  }
  const split = which === 2 ? 0.8 : 0.5;
  if (phase < split) return { note: true, local: phase / split };
  return { note: false, local: (phase - split) / (1 - split) };
}

/** Open hand at the bottom of the cut, a chirp once it closes the return. */
function scratchGain(note: boolean, local: number, cut: number): number {
  const shut = Math.min(1, clamp01(cut) * 1.4);
  if (!note || local < shut * 0.2 || local > 1 - shut * 0.2) return 1 - shut;
  return 1;
}

export interface ScratchNote {
  /** 1, 2 or 3 sixteenths. */
  len: number;
  /** 0 baby, 1 tear, 2 drag, 3 orbit. */
  type: number;
  /** -1 plays that scratch backwards. */
  sign: number;
}

function scratchNext(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

/**
 * One phrase for this press. Complexity is how many types and speeds may mix.
 * The voice in C rolls the same steps, so the two stay on the same sentence.
 */
export function scratchRoll(durationIndex: number, complexity: number, seed: number, press: number): ScratchNote[] {
  const dur = SCRATCH_DUR[pick(durationIndex, SCRATCH_DUR.length)] ?? 4;
  const level = pick(complexity, 4);
  const bag = SCRATCH_SPEED[level] ?? SCRATCH_SPEED[0];
  let state = (Math.imul(Math.round(seed) + 1, 997) ^ Math.imul(Math.round(press) + 1, 131) ^ Math.imul(level + 3, 17) ^ Math.imul(dur + 5, 53)) >>> 0;
  state = scratchNext(state);
  const root = state % 4;
  const span = level === 0 ? 1 : level === 1 ? 2 : level === 2 ? 3 : 4;
  const notes: ScratchNote[] = [];
  let left = dur;
  while (left > 0) {
    const fit: number[] = [];
    for (const n of bag) if (n <= left) fit.push(n);
    if (fit.length === 0) fit.push(left > 3 ? 3 : left);
    state = scratchNext(state);
    const len = fit[state % fit.length] ?? 1;
    state = scratchNext(state);
    const type = (root + (state % span)) % 4;
    state = scratchNext(state);
    const sign = level >= 2 && state % 4 === 0 ? -1 : 1;
    notes.push({ len, type, sign });
    left -= len;
  }
  return notes;
}

function parseGroupGesture(value: string): { group: DeckGroup; y: number } | null {
  if (value.length !== 4) return null;
  const group = value.slice(0, 3);
  const y = Number(value[3]);
  if (!isDeckGroup(group) || !Number.isInteger(y) || y < 0 || y > 3) return null;
  return { group, y };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pingPong(start: number, now: number, origin: number, slice: number): DeckRead {
  const period = Math.max(1, slice) * 2;
  const at = mod(now - origin, period);
  if (at <= slice) return { pos: start + at, live: 0, gain: 1, throw: 0, rate: 1 };
  return { pos: start + (period - at), live: 0, gain: 1, throw: 0, rate: -1 };
}

function reverseSlice(start: number, now: number, origin: number, slice: number): DeckRead {
  const into = mod(now - origin, Math.max(1, slice));
  return { pos: start + slice - into, live: 0, gain: 1, throw: 0, rate: -1 };
}

function readGroup(moment: DeckMoment, group: DeckGroup, y: number): DeckRead {
  const { knobs, tempo, barBeats, now, down, ahead, seed } = moment;
  const bar = barSamples(tempo, barBeats);
  const div = divSamples(knobs, tempo);
  const len = lenSamples(knobs, tempo, barBeats);
  const beat = Math.max(1, Math.round(samplesPerBeat(tempo)));
  const origin = group === "stp" ? down : snapUp(down, quantSamples(knobs, tempo, barBeats));
  if (now < origin) return identity(now);
  const held = now - origin;

  if (group === "rpt") {
    const start = origin - mod(origin, div) - div;
    if (y === 1) {
      const barStart = origin - mod(origin, bar);
      return { pos: barStart + mod(held, div), live: 0, gain: 1, throw: 0, rate: 1 };
    }
    if (y === 2) return reverseSlice(start, now, origin, div);
    if (y === 3) return pingPong(start, now, origin, div);
    return { pos: loopPos(start, now, origin, div), live: 0, gain: 1, throw: 0, rate: 1 };
  }

  if (group === "lop") {
    if (y === 1) {
      const future = ahead >= len;
      if (now >= origin + len) return identity(now);
      const windowEnd = future ? origin + len : origin;
      return { pos: windowEnd - held, live: 0, gain: 1, throw: 0, rate: -1 };
    }
    const start = origin - len;
    if (y === 2) return pingPong(start, now, origin, len);
    if (y === 3) {
      const step = Math.max(1, Math.round(beat / 4));
      const moved = start + Math.floor(held / Math.max(1, len)) * step;
      return { pos: moved + mod(held, len), live: 0, gain: 1, throw: 0, rate: 1 };
    }
    return { pos: loopPos(start, now, origin, len), live: 0, gain: 1, throw: 0, rate: 1 };
  }

  if (group === "glc") return readGlitch(moment, origin, y);

  if (group === "scr") return readScratch(moment, origin, y);

  if (group === "gat") {
    const base = [0.5, 0.28, 0.1, 0.5][y] ?? 0.5;
    const duty = Math.max(0.02, Math.min(0.95, base + (clamp01(knobs.duty) - 0.5) * 0.3));
    const into = mod(held, div);
    // The top row opens on the offbeat: the downbeat stays shut, the and plays.
    const on = y === 3 ? into >= div * (1 - duty) : into < div * duty;
    return { pos: now, live: 1, gain: on ? 1 : 0, throw: 0, rate: 1 };
  }

  if (group === "pch") return readPitch(moment, origin, y);

  if (group === "stp") {
    if (y === 1) {
      const target = nextDownbeat(origin, brakeSamples(knobs, tempo), bar);
      if (now >= target) return identity(now);
      return spinAt(origin, now, target);
    }
    if (y === 2) {
      const span = brakeSamples(knobs, tempo);
      const u = held / span;
      if (u >= 1) return identity(now);
      return {
        pos: origin + span * (2 / Math.PI) * (Math.cos(Math.PI * u) - 1),
        live: 0,
        gain: 1,
        throw: 0,
        rate: -2 * Math.sin(Math.PI * u),
      };
    }
    if (y === 3) return readBounce(origin, now, brakeSamples(knobs, tempo));
    const span = brakeSamples(knobs, tempo);
    const rate = brakeRate(held, span);
    if (rate < 0.02) return stopped(brakePos(span, span, origin));
    return { pos: brakePos(held, span, origin), live: 0, gain: 1, throw: 0, rate };
  }

  const open = div;
  const levels = [0.35, 1, 1, 1.5];
  let amt = 0;
  if (held < open) amt = levels[y] ?? 1;
  else if (y === 2) {
    const u = (held - open) / bar;
    amt = u >= 1 ? 0 : Math.exp(-3 * u);
  } else if (y === 3) {
    const u = (held - open) / beat;
    amt = u >= 1 ? 0 : 1.5 * (1 - u);
  }
  return { pos: now, live: 1, gain: 1, throw: amt, rate: 1 };
}

/** Straight, octave up, octave down, straight. Two straights keep the bar mostly in tune. */
const GLITCH_SPEED = [1, 2, 0.5, 1] as const;

function glitchHash(seed: number, windowIndex: number, slot: number, salt: number): number {
  let state = (Math.imul(seed + 1, 997) + Math.imul(windowIndex + 1, 131) + Math.imul(slot + 1, salt)) >>> 0;
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
}

/** How many times the attack fits in one slice. The grain never goes finer than a 32nd. */
function glitchCuts(y: number, held: number, beat: number, slice: number): number {
  const bias = [0, 0, 1, 2][pick(y, 4)] ?? 0;
  const steps = Math.min(3, bias + Math.floor(held / Math.max(1, beat)));
  let cuts = 1 << steps;
  const finest = Math.max(1, Math.round(beat / 8));
  while (cuts > 1 && Math.floor(slice / cuts) < finest) cuts >>= 1;
  return cuts;
}

function glitchSpeed(seed: number, slot: number, count: number): number {
  return GLITCH_SPEED[glitchHash(seed, 0, mod(slot, count), 17) % 4] ?? 1;
}

/**
 * Downbeat slices (phase 0) are read half a beat later, so a kick on 1 lands on the and.
 * Odd rows pick any slice of that phase. Even rows walk a shuffle of it.
 */
function glitchSource(seed: number, windowIndex: number, slot: number, count: number, perBeat: number, y: number): number {
  const order = glitchOrder(seed, windowIndex, count);
  const jump = y % 2 === 1;
  if (perBeat < 2) {
    if (!jump) return order[mod(slot, count)] ?? 0;
    return mod(glitchHash(seed, windowIndex, slot, 47), count);
  }
  const srcPhase = mod(mod(slot, perBeat) - Math.floor(perBeat / 2), perBeat);
  const bucket: number[] = [];
  for (const src of order) if (mod(src, perBeat) === srcPhase) bucket.push(src);
  if (bucket.length === 0) return order[mod(slot, count)] ?? 0;
  const at = jump ? mod(glitchHash(seed, windowIndex, slot, 47), bucket.length) : Math.floor(slot / perBeat) % bucket.length;
  return bucket[at] ?? 0;
}

function grainOffset(at: number, rate: number, grain: number): number {
  if (rate > 1.5) return mod(at * 2, grain);
  if (rate < 0.75) return Math.floor(at / 2);
  return mod(at, grain);
}

/** One bar of slices. A downbeat hit lands on the offbeat; holding stutters it and may jump an octave. */
function readGlitch(moment: DeckMoment, origin: number, y: number): DeckRead {
  const { knobs, tempo, barBeats, now, ahead, seed } = moment;
  const beat = Math.max(1, Math.round(samplesPerBeat(tempo)));
  const bar = barSamples(tempo, barBeats);
  const slice = Math.max(1, divSamples(knobs, tempo));
  const count = Math.max(1, Math.min(32, Math.floor(bar / slice)));
  const window = count * slice;
  const start = ahead >= window ? origin : origin - window;
  const held = now - origin;
  const perBeat = Math.max(1, Math.round(beat / slice));
  const slip = perBeat >= 2 ? 0 : Math.floor(beat / 2);
  const cuts = glitchCuts(y, held, beat, slice);
  const grain = Math.max(1, Math.floor(slice / cuts));
  const rate = cuts > 1 ? glitchSpeed(seed, Math.floor(held / slice), count) : 1;
  const src = glitchSource(seed, Math.floor(held / window), Math.floor(held / slice), count, perBeat, y);
  const local = mod(mod(held, slice) - slip, slice);
  return { pos: start + src * slice + grainOffset(local % grain, rate, grain), live: 0, gain: 1, throw: 0, rate };
}

/** A fresh sentence of short scratches. The row is the mix, the column is how long it runs. */
function readScratch(moment: DeckMoment, origin: number, complexity: number): DeckRead {
  const { knobs, tempo, now, seed, press } = moment;
  const sixteenth = Math.max(1, Math.round(samplesPerBeat(tempo) / 4));
  const notes = scratchRoll(knobs.brake, complexity, seed, press ?? 0);
  let sum = 0;
  for (const note of notes) sum += note.len;
  const cycle = Math.max(1, sum * sixteenth);
  const held = now - origin;
  const pos = mod(held, cycle);
  let acc = 0;
  let start = 0;
  let span = sixteenth;
  let note = notes[0] ?? { len: 2, type: 0, sign: 1 };
  for (const item of notes) {
    const next = Math.max(1, item.len * sixteenth);
    if (pos < acc + next) {
      start = acc;
      span = next;
      note = item;
      break;
    }
    acc += next;
  }
  const cycles = Math.floor(held / cycle);
  const noteAt = origin + cycles * cycle + start;
  const clock = scratchClock(span <= 1 ? 0 : (now - noteAt) / span, knobs.ramp);
  const reach = Math.max(1, (0.08 + clamp01(knobs.vary) * 0.92) * span);
  const dir = clock.dir * note.sign;
  const hand = scratchHand(note.type, clock.phase);
  const stroke = scratchStroke(note.type, clock.phase);
  const anchor = noteAt - scratchCue(knobs.len) * sixteenth;
  return {
    pos: anchor + hand.pos * reach * dir,
    live: 0,
    gain: scratchGain(stroke.note, stroke.local, knobs.duty),
    throw: 0,
    rate: (hand.dpos * clock.dWarp * reach * dir) / span,
  };
}

function readPitch(moment: DeckMoment, origin: number, y: number): DeckRead {
  const { knobs, tempo, barBeats, now, ahead } = moment;
  const bar = barSamples(tempo, barBeats);
  const beat = Math.max(1, Math.round(samplesPerBeat(tempo)));
  const base = PITCH_RATE[pick(knobs.div, PITCH_RATE.length)] * (1 + (clamp01(knobs.ramp) - 0.5) * 0.5);
  const held = now - origin;
  const rate = pitchRate(base, y, held, bar, beat);
  let pos = origin + pitchConsumed(base, y, held, bar, beat);
  if (pos > now + ahead && rate > 1) {
    const start = origin - beat;
    pos = start + mod(Math.round(pos - origin), beat);
  }
  return { pos, live: 0, gain: 1, throw: 0, rate };
}

function pitchRate(base: number, y: number, held: number, bar: number, beat: number): number {
  const u = Math.max(0, Math.min(1, held / bar));
  if (y === 1) return base * (1 + u);
  if (y === 2) return base * (1 - 0.5 * u);
  if (y === 3) return base * (1 + 0.12 * Math.sin((2 * Math.PI * held) / beat));
  return base;
}

function pitchConsumed(base: number, y: number, held: number, bar: number, beat: number): number {
  if (y === 1) {
    if (held <= bar) return base * (held + (held * held) / (2 * bar));
    return base * (bar * 1.5) + base * 2 * (held - bar);
  }
  if (y === 2) {
    if (held <= bar) return base * (held - (held * held) / (4 * bar));
    return base * (bar * 0.75) + base * 0.5 * (held - bar);
  }
  if (y === 3) {
    const swing = (0.12 * beat) / (2 * Math.PI);
    return base * (held - swing * (Math.cos((2 * Math.PI * held) / beat) - 1));
  }
  return held * base;
}

function readBounce(origin: number, now: number, span: number): DeckRead {
  const elapsed = now - origin;
  const parked = brakePos(span, span, origin);
  if (elapsed <= span) {
    const rate = brakeRate(elapsed, span);
    if (rate < 0.02) return { pos: parked, live: 0, gain: 1, throw: 0, rate };
    return { pos: brakePos(elapsed, span, origin), live: 0, gain: 1, throw: 0, rate };
  }
  const hop = span * 0.35;
  if (elapsed >= span + hop) return stopped(parked);
  const u = (elapsed - span) / hop;
  return { pos: parked - Math.sin(Math.PI * u) * span * 0.12, live: 0, gain: 1, throw: 0, rate: -Math.cos(Math.PI * u) };
}

function gestureRead(moment: DeckMoment, gesture: DeckGesture): DeckRead {
  const grouped = parseGroupGesture(gesture);
  if (grouped) return readGroup(moment, grouped.group, grouped.y);
  const { knobs, tempo, barBeats, now, down, ahead } = moment;
  const bar = barSamples(tempo, barBeats);
  const div = divSamples(knobs, tempo);
  const len = lenSamples(knobs, tempo, barBeats);
  const immediate = gesture === "stop" || gesture === "spin";
  const origin = immediate ? down : snapUp(down, quantSamples(knobs, tempo, barBeats));
  if (now < origin) return identity(now);

  if (gesture === "stop") {
    const span = brakeSamples(knobs, tempo);
    const elapsed = now - origin;
    const rate = brakeRate(elapsed, span);
    if (rate < 0.02) return stopped(brakePos(span, span, origin));
    return { pos: brakePos(elapsed, span, origin), live: 0, gain: 1, throw: 0, rate };
  }

  if (gesture === "spin") {
    const target = nextDownbeat(origin, brakeSamples(knobs, tempo), bar);
    if (now >= target) return identity(now);
    return spinAt(origin, now, target);
  }

  if (gesture === "roll" || gesture === "stut" || gesture === "hlx") {
    const slice = gesture === "stut" ? Math.max(1, Math.round(div / 2)) : div;
    // The last slice that has already been written. A grid-aligned press would
    // otherwise loop a window that starts at "now" and has not been rendered.
    const start = origin - mod(origin, slice) - slice;
    if (gesture !== "hlx") return { pos: loopPos(start, now, origin, slice), live: 0, gain: 1, throw: 0, rate: 1 };
    const held = now - origin;
    const rise = Math.min(1, held / bar);
    const rate = 1 + Math.max(0, knobs.ramp) * rise * 3;
    const consumed = held <= bar ? held + (Math.max(0, knobs.ramp) * 3 * held * held) / (2 * bar) : held * rate;
    return { pos: start + mod(consumed, slice), live: 0, gain: 1, throw: 0, rate };
  }

  if (gesture === "loop") {
    const start = origin - len;
    return { pos: loopPos(start, now, origin, len), live: 0, gain: 1, throw: 0, rate: 1 };
  }

  if (gesture === "rev") {
    // Prefer the window that has not been heard yet. Without that cushion,
    // reverse the window that just finished. Either one ends on its boundary.
    const future = ahead >= len;
    if (now >= origin + len) return identity(now);
    const windowEnd = future ? origin + len : origin;
    return { pos: windowEnd - (now - origin), live: 0, gain: 1, throw: 0, rate: -1 };
  }

  if (gesture === "jump") {
    const start = origin - mod(origin, bar);
    return { pos: start + mod(now - origin, div), live: 0, gain: 1, throw: 0, rate: 1 };
  }

  if (gesture === "glch") return readGlitch(moment, origin, 0);

  if (gesture === "tran") {
    const duty = 0.05 + Math.max(0, Math.min(1, knobs.duty)) * 0.9;
    const on = mod(now - origin, div) < div * duty;
    return { pos: now, live: 1, gain: on ? 1 : 0, throw: 0, rate: 1 };
  }

  if (gesture === "drop") return { pos: now, live: 1, gain: 0, throw: 0, rate: 1 };

  if (gesture === "half") {
    return { pos: origin + (now - origin) * 0.5, live: 0, gain: 1, throw: 0, rate: 0.5 };
  }

  if (gesture === "dbl") {
    const ran = (now - origin) * 2;
    const head = now + ahead;
    if (origin + ran <= head) return { pos: origin + ran, live: 0, gain: 1, throw: 0, rate: 2 };
    const start = origin - div;
    return { pos: start + mod(ran, div), live: 0, gain: 1, throw: 0, rate: 2 };
  }

  if (gesture === "back") {
    const beat = Math.max(1, samplesPerBeat(tempo));
    const u = (now - origin) / beat;
    if (u >= 1) return identity(now);
    const pos = origin + beat * (2 / Math.PI) * (Math.cos(Math.PI * u) - 1);
    return { pos, live: 0, gain: 1, throw: 0, rate: -2 * Math.sin(Math.PI * u) };
  }

  if (gesture === "scr") return readScratch(moment, origin, 0);

  return { pos: now, live: 1, gain: 1, throw: 1, rate: 1 };
}

/** Where the platter reads at `now`. A release crossfades back to the live head. */
export function deckRead(moment: DeckMoment): DeckRead {
  if (!moment.gesture) return identity(moment.now);
  const wet = gestureRead(moment, moment.gesture);
  const up = moment.up;
  if (up === null || moment.now < up) return wet;
  const t = Math.min(1, (moment.now - up) / DECK_FADE);
  const dry = Math.sin(t * Math.PI * 0.5);
  const keep = Math.cos(t * Math.PI * 0.5);
  return {
    pos: wet.pos,
    live: wet.live * keep + dry,
    gain: wet.gain * keep + dry,
    throw: wet.throw * keep,
    rate: wet.rate * keep + dry,
  };
}

export interface DeckPicture {
  /** Sample at the left edge of the strip. The stylus is the midpoint. */
  start: number;
  /** Samples across the strip. Always one bar, so a pad does not zoom. */
  span: number;
  /** Sample under the stylus. */
  head: number;
  /** Kept at 1. A mute lives in the voice and does not flatten the groove. */
  gain: number;
}

/**
 * One bar of platter, stylus in the middle. Gestures move `head`, and the
 * groove scrolls under it. The scale stays the bar. Depth is the wet mix in
 * the voice; the strip always shows the full gesture, including while a
 * transformer, a drop, or a parked head is silent.
 */
export function deckPicture(moment: DeckMoment): DeckPicture {
  const read = deckRead(moment);
  const head = moment.now * read.live + read.pos * (1 - read.live);
  const span = barSamples(moment.tempo, moment.barBeats);
  return { start: head - span / 2, span, head, gain: 1 };
}

export interface DeckCommand {
  gesture: DeckGesture | null;
  /** Changes when a pad retriggers the same cell, so the voice takes a new entry. */
  press?: number;
  knobs: DeckKnobs;
  warm: boolean;
  seed: number;
  barBeats: number;
}

/** One short record the voice can apply between blocks. `-` is no gesture. */
export function formatDeckCommand(command: DeckCommand): string {
  const knobs = command.knobs;
  const nums = [knobs.div, knobs.len, knobs.depth, knobs.brake, knobs.vary, knobs.quant, knobs.duty, knobs.ramp]
    .map((n, index) => (index === 1 || index === 2 || index === 4 || index === 6 || index === 7 ? n.toFixed(4) : String(Math.round(n))))
    .join(",");
  const tone = [knobs.filter, knobs.resonance, knobs.drive, knobs.low, knobs.mid, knobs.high].map((n) => n.toFixed(4)).join(",");
  const name = command.gesture ?? "-";
  const token = command.gesture && command.press ? `${name}#${Math.round(command.press)}` : name;
  return `D|${token}|${nums},${tone}|${command.warm ? 1 : 0}|${Math.round(command.seed)}|${Math.max(1, Math.round(command.barBeats))}`;
}

export function parseDeckCommand(text: string): DeckCommand | null {
  if (!text.startsWith("D|")) return null;
  const parts = text.split("|");
  if (parts.length < 6) return null;
  const nums = parts[2].split(",").map((item) => Number(item));
  if ((nums.length !== 8 && nums.length !== 14) || nums.some((n) => !Number.isFinite(n))) return null;
  const home = defaultDeck();
  const hash = parts[1].indexOf("#");
  const token = hash >= 0 ? parts[1].slice(0, hash) : parts[1];
  const press = hash >= 0 ? Math.round(Number(parts[1].slice(hash + 1))) || 0 : 0;
  const gesture = token === "-" ? null : isDeckGesture(token) ? token : null;
  if (token !== "-" && gesture === null) return null;
  return {
    gesture,
    press,
    knobs: {
      div: nums[0],
      len: nums[1],
      depth: nums[2],
      brake: nums[3],
      vary: nums[4],
      quant: nums[5],
      duty: nums[6],
      ramp: nums[7],
      filter: nums.length === 14 ? nums[8] : home.filter,
      resonance: nums.length === 14 ? nums[9] : home.resonance,
      drive: nums.length === 14 ? nums[10] : home.drive,
      low: nums.length === 14 ? nums[11] : home.low,
      mid: nums.length === 14 ? nums[12] : home.mid,
      high: nums.length === 14 ? nums[13] : home.high,
      cells: home.cells,
      focus: 0,
    },
    warm: parts[3] === "1",
    seed: Number(parts[4]) || 0,
    barBeats: Math.max(1, Number(parts[5]) || 4),
  };
}

export function divLabel(knobs: DeckKnobs): string {
  return DIV_LABEL[pick(knobs.div, DIV_LABEL.length)];
}

/** Sixteenths the length knob stands for. The cell shows this count. */
export function lenCount(knobs: DeckKnobs, barBeats: number): number {
  const sixteenths = Math.max(1, Math.round(barBeats) * 4);
  const unit = Math.max(0, Math.min(1, knobs.len));
  return 1 + Math.min(sixteenths - 1, Math.floor(unit * sixteenths));
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

/** Header form. Two sixteenths read as `1/8`, not `2/16`. */
export function lenLabel(knobs: DeckKnobs, barBeats: number): string {
  const count = lenCount(knobs, barBeats);
  const divisor = gcd(count, 16);
  return `${count / divisor}/${16 / divisor}`;
}
