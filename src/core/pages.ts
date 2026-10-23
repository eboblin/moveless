import { DECK_GROUPS, deckSlots, defaultDeck, focusedGroup, rowKnobName, type DeckGroup, type DeckKnobs, type DeckSlot } from "./deck.ts";
import {
  LANE_CODE,
  LANES,
  SCALE_IDS,
  STEPS,
  isDrum,
  isPitched,
  laneFamily,
  type ContextId,
  type DrumId,
  type LaneId,
  type PatternId,
  type PitchedId,
  type Project,
  type RandomizeScope,
} from "./types.ts";

export type MorphKind = "lerp" | "switch";
export type KnobStore = "lane" | "progression" | "global" | "mixer" | "macro" | "bus" | "deck";
/** How the screen draws a knob. `number` is the plain 0..99 cell. */
export type KnobDisplay = "number" | "pitch" | "octave" | "note" | "scale" | "division" | "chordTone" | "slice" | "count";

export interface Binding {
  path: string;
  /** Token tests and the focus record use this (`G1 PRB`). */
  label: string;
  /** Cell name: last token, three letters (`PRB`, `FOL`). */
  short: string;
  /** Focus header with the short tokens expanded (`GEN 1 LENGTH`). */
  title: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  store: KnobStore;
  morph: MorphKind;
  /** Randomize cost of one full-scale step toward home. */
  weight: number;
  display: KnobDisplay;
  /** Macro keys that add into this knob. Absent when the knob is not shifted. */
  macro?: readonly string[];
  /** Values the encoder holds for one extra click. Same units as the knob, not the 0..99 cell. */
  detents?: readonly number[];
}

export type PageGroup = "pattern" | "notes" | "sound" | "fx" | "global" | "macro" | "mix" | "bus" | "deck";

export interface Page {
  id: string;
  /** Jog overlay name. The header uses `groups`; a knob's own name is `Binding.title`. */
  title: string;
  /** Names for the left and right knob fours; shown right-aligned in each header half. */
  groups: [string | null, string | null];
  /** Pad colour family. Lives on the page so it cannot drift from the page list. */
  group: PageGroup;
  bindings: (Binding | null)[];
}

/** Move pad colors. Pattern, notes, sound and filter stay the same on every lane. */
export const PAGE_GROUP_COLOR: Record<PageGroup, number> = {
  pattern: 3,
  notes: 14,
  sound: 20,
  fx: 9,
  global: 8,
  macro: 22,
  mix: 18,
  bus: 16,
  deck: 11,
};

const TITLE_WORD: Record<string, string> = {
  G1: "GEN 1",
  G2: "GEN 2",
  LEN: "LENGTH",
  HIT: "HITS",
  ROT: "ROTATE",
  PRB: "PROB",
  VEL: "VELOCITY",
  V: "VALUE",
  P: "PATTERN",
  C: "CYCLE",
  A: "AMOUNT",
  TRANS: "TRANSPOSE",
  PMP: "PUMP",
  TLT: "TILT",
  DIV: "DIVISION",
  DEP: "DEPTH",
  BRK: "BRAKE",
  SHP: "SHAPE",
  QNT: "QUANT",
  DUT: "DUTY",
  WAY: "WAY",
  PAT: "PATTERN",
  CRV: "CURVE",
  RTE: "RATE",
  OPN: "OPEN",
  SND: "SEND",
  TIM: "TIME",
  VAR: "VARY",
  BND: "BEND",
  RMP: "RAMP",
  SCR: "SCRATCH",
  TRN: "TRANSFORM",
  HLX: "HELIX",
  KCK: "KICK",
  SNR: "SNARE",
  PRC: "PERC",
  BAS: "BASS",
  LEA: "LEAD",
  CHD: "CHORDS",
  FX: "FX",
};

const EMPTY: (Binding | null)[] = [null, null, null, null, null, null, null, null];

/** Space, mixer, global, progression, and macro knobs that are not a named role. */
const PLAIN_WEIGHT = 4;

/** One semantic field. Every lane that has the id uses this label, value weight, and screen. */
interface FieldSpec {
  label: string;
  weight: number;
  display?: KnobDisplay;
  /** Hold on the value slot. Omitted when a second use of the id needs a different hold. */
  detent?: readonly number[];
  /** Value-slot travel. Omitted slots keep the 0..1 hundredth. */
  step?: number;
  max?: number;
  /** Macro keys that feed the field. Defaults to the field's own name. */
  macro?: readonly string[];
}

/**
 * Slots of a modulated value. `value` takes its weight and screen from the field.
 * Pattern, cycle, and amount are the same on every field.
 */
const SLOT = {
  value: { min: 0, max: 1, step: 0.01, suffix: "V" },
  pattern: { weight: 1, min: 0, max: 63, step: 1, suffix: "P" },
  cycle: { weight: 1.5, min: 1, max: 64, step: 1, suffix: "C" },
  amount: { weight: 1.2, min: -1, max: 1, step: 0.01, suffix: "A" },
} as const;

/** Euclidean voice. Labels stay the short tokens `TITLE_WORD` expands. Hits is light so a reroll can change the count; length stays heavy. */
const EUCLID = {
  length: { weight: 6, min: 0, max: 64, step: 1, integer: true, word: "LEN", powers: true },
  hits: { weight: 2, min: 0, max: 64, step: 1, integer: true, word: "HIT" },
  rotate: { weight: 2, min: 0, max: 64, step: 1, integer: true, word: "ROT" },
  probability: { weight: 3, min: 0, max: 1, step: 0.01, integer: false, word: "PRB", macro: ["probability"] as const },
} as const;

/** A whole-page shape, same cost as a generator length. */
const FOLLOW_WEIGHT = 6;

function spec(label: string, weight: number, extra?: Omit<Partial<FieldSpec>, "label" | "weight">): FieldSpec {
  return { label, weight, ...extra };
}

const FIELD = {
  pitch: spec("PITCH", 2, { display: "pitch" }),
  cutoff: spec("CUTOFF", 2, { detent: [0.5] }),
  tone: spec("TONE", 2, { display: "chordTone" }),
  decay: spec("DECAY", 2),
  snap: spec("SNAP", 2),
  body: spec("BODY", 2),
  metal: spec("METAL", 2),
  material: spec("MATERIAL", 2),
  /** Eight repeats. One click is one repeat; the cell shows 1..8, not 0..100. */
  count: spec("COUNT", 8, { macro: ["count", "repeat"], display: "count", step: 1 / 8, max: 7 / 8 }),
  repeat: spec("REPEAT", 8),
  rate: spec("RATE", 8, { display: "division" }),
  bendTime: spec("B TIME", 1),
  bodyDecay: spec("B DECAY", 1, { macro: ["bodyDecay", "decay"] }),
  noiseDecay: spec("N DECAY", 1, { macro: ["noiseDecay", "decay"] }),
  ring: spec("RESO", 1),
  fmRatio: spec("RATIO", 1),
  pos: spec("POS", 1, { detent: [0.5] }),
  release: spec("RELEASE", 1, { macro: ["release", "decay"] }),
  color: spec("COLOR", 1, { macro: ["color", "tone"] }),
  octave: spec("OCTAVE", 1, { display: "octave" }),
  bend: spec("BEND", 1),
  click: spec("CLICK", 1),
  noise: spec("NOISE", 1),
  drive: spec("DRIVE", 1),
  attack: spec("ATTACK", 1),
  fm: spec("FM", 1),
  damp: spec("DAMP", 1),
  wave: spec("WAVE", 1),
  sync: spec("SYNC", 1),
  fold: spec("FOLD", 1),
  wide: spec("WIDE", 1),
  step: spec("STEP", 1),
  gate: spec("GATE", 1),
  size: spec("SIZE", 4, { display: "slice", macro: [] }),
  velocity: spec("VEL", 1),
  probability: spec("PRB", 3),
  length: spec("LENGTH", 1),
  resonance: spec("RESO", 1),
  reverb: spec("REV", 1),
  delay: spec("DLY", 1),
};

type FieldId = keyof typeof FIELD;

/**
 * Sound order for each lane. Pages, factory homes, and the voice map read this list.
 * A lane only chooses which fields it has; the spec above is shared.
 */
export const SOUND = {
  kick: ["pitch", "decay", "bend", "bendTime", "body", "click", "noise", "drive"],
  snare: ["pitch", "body", "bodyDecay", "noise", "noiseDecay", "snap", "tone", "drive"],
  hat: ["pitch", "metal", "noise", "color", "decay", "attack", "ring", "pos"],
  perc: ["pitch", "material", "decay", "bend", "fm", "fmRatio", "attack", "damp"],
  bass: ["wave", "bend", "sync", "fold", "drive", "wide", "attack", "release"],
  lead: ["wave", "bend", "sync", "fold", "drive", "wide", "attack", "release"],
  chords: ["wave", "bend", "sync", "fold", "drive", "wide", "attack", "release"],
} as const satisfies Record<LaneId, readonly FieldId[]>;

/** Sum of the macro keys that feed one phrase field. Does not walk the page list. */
export function macroOffset(field: string, macros: Record<string, number>): number {
  const specFor = FIELD[field as FieldId];
  const keys = specFor?.macro ?? [field];
  let sum = 0;
  for (const key of keys) sum += macros[key] ?? 0;
  return sum;
}

function slots(bindings: (Binding | null)[]): (Binding | null)[] {
  const out = EMPTY.slice();
  bindings.forEach((binding, index) => {
    if (index < 8) out[index] = binding;
  });
  return out;
}

function shortLabel(label: string): string {
  const parts = label.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? "").slice(0, 3);
}

function titleLabel(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .map((part) => TITLE_WORD[part] ?? part)
    .join(" ");
}

/** Powers of two inside the range, including an end when that end is itself a power of two. */
function powersOfTwo(min: number, max: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= max; n *= 2) {
    if (n >= min) out.push(n);
    if (n > max / 2) break;
  }
  return out;
}

/** Value and amount of timbre (sound, filter, send, fx) step. Every other slot switches. */
function morphKind(group: PageGroup, slot: "value" | "amount" | "other"): MorphKind {
  if ((group === "sound" || group === "fx") && (slot === "value" || slot === "amount")) return "lerp";
  return "switch";
}

function bind(input: {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  weight: number;
  integer?: boolean;
  store?: KnobStore;
  morph?: MorphKind;
  display?: KnobDisplay;
  macro?: readonly string[];
  detents?: readonly number[] | "powers";
}): Binding {
  const raw =
    input.detents === "powers"
      ? powersOfTwo(input.min, input.max)
      : (input.detents ?? (input.min < 0 && input.max > 0 ? [0] : []));
  const picked = raw.filter((value) => value >= input.min && value <= input.max);
  return {
    path: input.path,
    label: input.label,
    short: shortLabel(input.label),
    title: titleLabel(input.label),
    min: input.min,
    max: input.max,
    step: input.step,
    integer: input.integer ?? false,
    store: input.store ?? "lane",
    morph: input.morph ?? "switch",
    weight: input.weight,
    display: input.display ?? "number",
    ...(input.macro ? { macro: input.macro } : {}),
    ...(picked.length ? { detents: picked } : {}),
  };
}

function vpca(path: string, field: FieldSpec, group: PageGroup, label = field.label): Binding[] {
  const id = path.slice(path.lastIndexOf(".") + 1);
  return [
    bind({
      path: `${path}.value`,
      label: `${label} ${SLOT.value.suffix}`,
      min: SLOT.value.min,
      max: field.max ?? SLOT.value.max,
      step: field.step ?? SLOT.value.step,
      weight: field.weight,
      display: field.display,
      detents: field.detent,
      macro: field.macro ?? [id],
      morph: morphKind(group, "value"),
    }),
    bind({
      path: `${path}.pattern`,
      label: `${label} ${SLOT.pattern.suffix}`,
      min: SLOT.pattern.min,
      max: SLOT.pattern.max,
      step: SLOT.pattern.step,
      integer: true,
      weight: SLOT.pattern.weight,
      morph: morphKind(group, "other"),
    }),
    bind({
      path: `${path}.cycle`,
      label: `${label} ${SLOT.cycle.suffix}`,
      min: SLOT.cycle.min,
      max: SLOT.cycle.max,
      step: SLOT.cycle.step,
      integer: true,
      weight: SLOT.cycle.weight,
      detents: "powers",
      morph: morphKind(group, "other"),
    }),
    bind({
      path: `${path}.amount`,
      label: `${label} ${SLOT.amount.suffix}`,
      min: SLOT.amount.min,
      max: SLOT.amount.max,
      step: SLOT.amount.step,
      weight: SLOT.amount.weight,
      morph: morphKind(group, "amount"),
    }),
  ];
}

function page(id: string, title: string, groups: [string | null, string | null], group: PageGroup, bindings: (Binding | null)[]): Page {
  return { id, title, groups, group, bindings: slots(bindings) };
}

function pair(aPath: string, a: FieldSpec, bPath: string, b: FieldSpec, group: PageGroup): Page {
  return page(aPath, `${a.label} / ${b.label}`, [a.label, b.label], group, [...vpca(aPath, a, group), ...vpca(bPath, b, group)]);
}

function euclid(which: 1 | 2, slot: keyof typeof EUCLID): Binding {
  const role = EUCLID[slot];
  return bind({
    path: `gen${which}.${slot}`,
    label: `G${which} ${role.word}`,
    min: role.min,
    max: role.max,
    step: role.step,
    integer: role.integer,
    weight: role.weight,
    ...("powers" in role && role.powers ? { detents: "powers" as const } : {}),
    ...("macro" in role ? { macro: role.macro } : {}),
  });
}

function genPage(which: 1 | 2): Page {
  const tag = `G${which}`;
  return page(`gen${which}`, `GENERATOR ${which}`, [`GEN ${which}`, "VEL"], "pattern", [
    euclid(which, "length"),
    euclid(which, "hits"),
    euclid(which, "rotate"),
    euclid(which, "probability"),
    ...vpca(`gen${which}.velocity`, FIELD.velocity, "pattern", `${tag} VEL`),
  ]);
}

function lengthPage(): Page {
  return page("length", "LENGTH", ["LENGTH", "FOLLOW"], "notes", [
    ...vpca("length", FIELD.length, "notes"),
    bind({ path: "follow", label: "FOLLOW", min: 0, max: 1, step: 0.01, weight: FOLLOW_WEIGHT }),
  ]);
}

function soundPages(ids: readonly FieldId[]): Page[] {
  const pages: Page[] = [];
  for (let i = 0; i < ids.length; i += 2) {
    const a = ids[i];
    const b = ids[i + 1];
    if (!a || !b) break;
    pages.push(pair(`sound.${a}`, FIELD[a], `sound.${b}`, FIELD[b], "sound"));
  }
  return pages;
}

function filterPage(): Page {
  const item = pair("filter.cutoff", FIELD.cutoff, "filter.resonance", FIELD.resonance, "fx");
  return { ...item, groups: ["FLT CUTOFF", "FLT RESO"] };
}

function sendPage(): Page {
  return pair("send.reverb", FIELD.reverb, "send.delay", FIELD.delay, "fx");
}

function drumPages(lane: DrumId): Page[] {
  return [
    genPage(1),
    genPage(2),
    pair("ratchet.count", FIELD.count, "ratchet.rate", FIELD.rate, "pattern"),
    ...soundPages(SOUND[lane]),
    filterPage(),
    sendPage(),
  ];
}

function pitchedPages(lane: PitchedId): Page[] {
  return [
    genPage(1),
    genPage(2),
    pair("repeat", FIELD.repeat, "step", FIELD.step, "pattern"),
    // Drum pitch has no center hold. Only the note pitch rests at 0.5.
    pair("pitch", { ...FIELD.pitch, detent: [0.5] }, "octave", FIELD.octave, "notes"),
    lengthPage(),
    ...soundPages(SOUND[lane]),
    filterPage(),
    sendPage(),
  ];
}

function chordGenPage(): Page {
  return page("gen1", "GENERATOR 1", ["GEN 1", "SIZE"], "pattern", [
    euclid(1, "length"),
    euclid(1, "hits"),
    euclid(1, "rotate"),
    euclid(1, "probability"),
    ...vpca("size", FIELD.size, "pattern"),
  ]);
}

function chordPages(): Page[] {
  return [
    chordGenPage(),
    page("play", "PLAY", ["RATE", "GATE"], "pattern", [
      ...vpca("rate", FIELD.rate, "pattern"),
      ...vpca("gate", FIELD.gate, "pattern"),
    ]),
    page("velocity", "VEL", ["VEL", "PRB"], "pattern", [
      ...vpca("velocity", FIELD.velocity, "pattern"),
      ...vpca("probability", FIELD.probability, "pattern"),
    ]),
    pair("tone", FIELD.tone, "octave", FIELD.octave, "notes"),
    ...soundPages(SOUND.chords),
    filterPage(),
    sendPage(),
  ];
}

const DRUM_PAGES: Record<DrumId, Page[]> = {
  kick: drumPages("kick"),
  snare: drumPages("snare"),
  hat: drumPages("hat"),
  perc: drumPages("perc"),
};

const PITCHED_PAGES: Record<PitchedId, Page[]> = {
  bass: pitchedPages("bass"),
  lead: pitchedPages("lead"),
};

const CHORD_PAGES: Page[] = chordPages();

function plain(
  path: string,
  label: string,
  min: number,
  max: number,
  step: number,
  integer: boolean,
  store: KnobStore,
  display?: KnobDisplay,
  morph?: MorphKind,
): Binding {
  return bind({ path, label, min, max, step, integer, store, weight: PLAIN_WEIGHT, display, morph });
}

function plainPage(
  id: string,
  title: string,
  left: string,
  right: string,
  group: PageGroup,
  store: KnobStore,
  knobs: readonly [string, string][],
  morph?: MorphKind,
): Page {
  return page(
    id,
    title,
    [left, right],
    group,
    knobs.map(([key, label]) => plain(`${id}.${key}`, label, 0, 1, 0.01, false, store, undefined, morph)),
  );
}

function progPage(): Page {
  return page("prog", "CHORDS", ["WALK", "TONE"], "notes", [
    plain("start", "START", -7, 7, 1, true, "progression"),
    plain("count", "COUNT", 0, 16, 1, true, "progression"),
    plain("length", "LENGTH", 0, 4, 1, true, "progression"),
    plain("motion", "MOTION", 0, 7, 1, true, "progression"),
    plain("variation", "VARIATION", 0, 3, 1, true, "progression"),
    plain("mood", "MOOD", 0, 1, 0.01, false, "progression"),
    plain("tension", "TENSION", 0, 1, 0.01, false, "progression"),
    plain("way", "WAY", 0, 3, 1, true, "progression"),
  ]);
}

const FX_PAGES: Page[] = [
  plainPage("reverb", "REVERB", "REV SIZE", "REV TAIL", "fx", "lane", [
    ["size", "SIZE"],
    ["decay", "DECAY"],
    ["damp", "DAMP"],
    ["diff", "DIFF"],
    ["pre", "PRE"],
    ["width", "WIDTH"],
    ["low", "LOW"],
    ["level", "LEVEL"],
  ], "lerp"),
  plainPage("delay", "DELAY", "DLY TIME", "DLY ECHO", "fx", "lane", [
    ["time", "TIME"],
    ["feed", "FEED"],
    ["hi", "HI"],
    ["lo", "LO"],
    ["width", "WIDTH"],
    ["mod", "MOD"],
    ["rate", "RATE"],
    ["level", "LEVEL"],
  ], "lerp"),
];

const DECK_FACE: Record<DeckSlot, { label: string; min: number; max: number; step: number; integer: boolean }> = {
  div: { label: "DIV", min: 0, max: 5, step: 1, integer: true },
  len: { label: "LEN", min: 0, max: 1, step: 0.01, integer: false },
  depth: { label: "DEP", min: 0, max: 1, step: 0.01, integer: false },
  brake: { label: "TIM", min: 0, max: 5, step: 1, integer: true },
  vary: { label: "VAR", min: 0, max: 1, step: 0.01, integer: false },
  quant: { label: "QNT", min: 0, max: 3, step: 1, integer: true },
  duty: { label: "DUT", min: 0, max: 1, step: 0.01, integer: false },
  ramp: { label: "BND", min: 0, max: 1, step: 0.01, integer: false },
  row: { label: "WAY", min: 0, max: 3, step: 1, integer: true },
  rate: { label: "RTE", min: 0, max: 5, step: 1, integer: true },
  open: { label: "OPN", min: 0, max: 5, step: 1, integer: true },
};

/** Knobs of the selected group. Depth is always the rightmost encoder. */
export function deckPage(group: DeckGroup, knobs: DeckKnobs): Page {
  const bindings = deckSlots(group, knobs).map((slot) => {
    if (!slot) return null;
    const face = DECK_FACE[slot];
    const label = slot === "row" ? rowKnobName(group) : face.label;
    return plain(`deck.${slot}`, label, face.min, face.max, face.step, face.integer, "deck");
  });
  return page("deck", "DJ FX", [null, null], "bus", bindings);
}

function rememberDeck(): void {
  const knobs = defaultDeck();
  const divided = { ...knobs, quant: 1 };
  for (const group of DECK_GROUPS) remember([deckPage(group, knobs), deckPage(group, divided)]);
}

function mixPage(): Page {
  return page("mixer", "MIXER", ["MIXER", null], "mix", [
    ...LANES.map((lane) => plain(lane, LANE_CODE[lane], 0, 1, 0.01, false, "mixer")),
    plain("master", "MASTER", 0, 1, 0.01, false, "mixer"),
  ]);
}

/** Purple-lane slot for DJ FX. Live knobs come from `deckPage` of the focused group. */
function deckAuxPage(): Page {
  return page("deck", "DJ FX", [null, null], "deck", []);
}

function globalPage(): Page {
  return page("settings", "GLOBAL", ["TIME", "FORM"], "global", [
    plain("tempo", "TEMPO", 40, 240, 1, true, "global"),
    plain("swing", "SWING", 0, 1, 0.01, false, "global"),
    plain("root", "ROOT", 0, 11, 1, true, "global", "note"),
    plain("scale", "SCALE", 0, SCALE_IDS.length - 1, 1, true, "global", "scale"),
    plain("transpose", "TRANS", -24, 24, 1, true, "global"),
    plain("bar", "BAR", 1, 16, 1, true, "global"),
    plain("phrase", "PHRASE", 1, 64, 1, true, "global"),
    plain("seed", "SEED", 0, 999, 1, true, "global"),
  ]);
}

function macroPage(id: string, title: string, groups: [string | null, string | null], knobs: readonly (readonly [string, string, number?])[]): Page {
  return page(
    id,
    title,
    groups,
    "macro",
    knobs.map(([key, label, weight = PLAIN_WEIGHT]) =>
      bind({
        path: `macro.${key}`,
        label,
        min: -1,
        max: 1,
        step: 0.01,
        store: "macro",
        weight,
      }),
    ),
  );
}

/** One performance page. Rhythm on the left, sound on the right. */
function perfPage(): Page {
  return macroPage("play", "MACROS", ["PLAY", "TONE"], [
    ["probability", "DENS", EUCLID.probability.weight],
    ["repeat", "REP"],
    ["rate", "RATE"],
    ["velocity", "VEL"],
    ["cutoff", "CUT"],
    ["resonance", "RES"],
    ["drive", "DRV"],
    ["decay", "DECAY"],
  ]);
}

function busPage(): Page {
  const knob = (path: string, label: string, min: number, max: number) =>
    bind({
      path: `bus.${path}`,
      label,
      min,
      max,
      step: 0.01,
      weight: PLAIN_WEIGHT,
      store: "bus",
      ...(min >= 0 ? { detents: [0] } : {}),
    });
  return page("bus", "BUS", ["MIX", null], "bus", [
    knob("glue", "GLUE", 0, 1),
    knob("pump", "PMP", 0, 1),
    knob("wide", "WIDE", 0, 1),
    knob("tilt", "TLT", -1, 1),
  ]);
}

/** Global, progression, the macro page, the bus, then mixer and DJ FX. Fx is its own lane. */
const AUX_PAGES: Page[] = [globalPage(), progPage(), perfPage(), busPage(), mixPage(), deckAuxPage()];

/** Eight mixer faders on the purple lane. */
export function mixerPage(): Page {
  return AUX_PAGES.find((item) => item.id === "mixer") ?? mixPage();
}

/** Id of one context page. The index clamps into the page list. */
export function pageId(context: ContextId, index: number): string | null {
  const pages = pagesFor(context);
  if (!pages.length) return null;
  const clamped = Math.min(Math.max(0, index), pages.length - 1);
  return pages[clamped]?.id ?? null;
}

/**
 * Page the caller is showing. The deck slot expands to the knobs of the focused group.
 */
export function livePage(project: Project, context: ContextId, index: number): Page | undefined {
  const pages = pagesFor(context);
  const item = pages[Math.min(Math.max(0, index), Math.max(0, pages.length - 1))];
  if (!item) return undefined;
  if (item.id !== "deck") return item;
  return deckPage(focusedGroup(project.deck), project.deck);
}

/** Name the jog overlay prints. Mixer and DJ FX keep a fixed word even when the deck group changes. */
export function pageTitle(project: Project, context: ContextId, index: number): string {
  const item = livePage(project, context, index);
  if (!item) return "";
  if (item.id === "mixer") return "MIXER";
  if (item.id === "deck") return "DJ FX";
  return item.title;
}

export function lanePages(lane: PatternId): Page[] {
  if (lane === "fx") return FX_PAGES;
  switch (laneFamily(lane)) {
    case "drum":
      if (isDrum(lane)) return DRUM_PAGES[lane];
      break;
    case "pitched":
      if (isPitched(lane)) return PITCHED_PAGES[lane];
      break;
    case "chords":
      return CHORD_PAGES;
  }
  throw new Error(`no pages for ${lane}`);
}

const pageCache = new Map<ContextId, Page[]>();
const byPath = new Map<string, Binding>();

function remember(pages: Page[]): void {
  for (const item of pages) {
    for (const binding of item.bindings) {
      if (binding && !byPath.has(binding.path)) byPath.set(binding.path, binding);
    }
  }
}

export function pagesFor(context: ContextId): Page[] {
  const hit = pageCache.get(context);
  if (hit) return hit;
  const pages = context === "aux" ? AUX_PAGES : lanePages(context);
  remember(pages);
  pageCache.set(context, pages);
  return pages;
}

export function pageCount(context: ContextId): number {
  return pagesFor(context).length;
}

/** Knob paths on one page, in column order. Randomize spends these, not a second list. */
export function bindingPaths(page: Page): string[] {
  const paths: string[] = [];
  for (const binding of page.bindings) if (binding) paths.push(binding.path);
  return paths;
}

/** Pattern, notes, sound, or fx pages for a lane, taken from the same pages the screen shows. */
export function laneScopePaths(lane: PatternId, scope: "pattern" | "notes" | "sound" | "fx" | "all"): string[][] {
  const pages = pagesFor(lane);
  const picked: string[][] = [];
  for (const item of pages) {
    if (item.group !== "pattern" && item.group !== "notes" && item.group !== "sound" && item.group !== "fx") continue;
    if (scope !== "all" && item.group !== scope) continue;
    picked.push(bindingPaths(item));
  }
  return picked;
}

/** Paths of one generator. A paired page contributes only the named modulator. */
export function modulatorPaths(lane: PatternId, target: string): string[] {
  if (target === "gen1" || target === "gen2") {
    const found = pagesFor(lane).find((item) => item.id === target);
    return found ? bindingPaths(found) : [];
  }
  const prefix = `${target}.`;
  const paths: string[] = [];
  for (const item of pagesFor(lane)) {
    for (const binding of item.bindings) {
      if (binding && (binding.path === target || binding.path.startsWith(prefix))) paths.push(binding.path);
    }
  }
  return paths;
}

export function pageGroup(context: ContextId, index: number): PageGroup {
  const pages = pagesFor(context);
  const found = pages[index] ?? pages[pages.length - 1];
  return found?.group ?? "pattern";
}

/**
 * Pages the scope geometry includes. `lane` is every page, `page` is the current
 * one, `group` is the current page's group. Aux groups stay as they are
 * (progression, global, macro, bus, mix, deck). Lane pattern pages still share one group.
 */
export function scopeIncludesPage(scope: RandomizeScope, context: ContextId, index: number, page: number): boolean {
  const item = pagesFor(context)[index];
  if (!item) return false;
  if (scope === "lane") return true;
  if (scope === "page") return index === page;
  if (context === "aux") return item.group === pageGroup(context, page);
  const group = pageGroup(context, page);
  const collapsed = group === "sound" || group === "notes" || group === "fx" ? group : "pattern";
  return item.group === collapsed;
}

export function pageGroupColor(context: ContextId, index: number): number {
  return PAGE_GROUP_COLOR[pageGroup(context, index)];
}

/** First binding with this path. Ranges are the same on every lane that has the knob. */
export function bindingFor(path: string): Binding | null {
  return byPath.get(path) ?? null;
}

for (const context of STEPS) pagesFor(context);
remember([mixerPage()]);
rememberDeck();
