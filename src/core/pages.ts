import {
  LANE_CODE,
  LANES,
  SCALE_IDS,
  SOUND,
  STEPS,
  isDrum,
  isPitched,
  laneFamily,
  type ContextId,
  type DrumId,
  type LaneId,
  type PitchedId,
} from "./types.ts";

export type MorphKind = "lerp" | "switch";
export type KnobStore = "lane" | "progression" | "space" | "global" | "mixer" | "macro";
/** How the screen draws a knob. `number` is the plain 0..99 cell. */
export type KnobDisplay = "number" | "pitch" | "octave" | "note" | "scale" | "division" | "chordTone";

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
  /** Capture cost of one full-scale step toward home. */
  weight: number;
  display: KnobDisplay;
  /** Macro keys that add into this knob. Absent when the knob is not shifted. */
  macro?: readonly string[];
  /** Values the encoder holds for one extra click. Same units as the knob, not the 0..99 cell. */
  detents?: readonly number[];
}

export type PageGroup = "pattern" | "notes" | "sound" | "fx" | "space" | "global" | "macro" | "mix";

export interface Page {
  id: string;
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
  space: 9,
  global: 8,
  macro: 22,
  mix: 120,
};

/**
 * Extra macro keys besides the field's own name.
 * `count` has no knob: REP still pushes ratchet count. `reverb` and `delay` likewise.
 * DECAY also lengthens a melodic release.
 */
const MACRO_ALSO: Record<string, readonly string[]> = {
  count: ["count", "repeat"],
  release: ["release", "decay"],
};

/** Sum of the macro keys that feed one phrase field. Does not walk the page list. */
export function macroOffset(field: string, macros: Record<string, number>): number {
  const keys = MACRO_ALSO[field] ?? [field];
  let sum = 0;
  for (const key of keys) sum += macros[key] ?? 0;
  return sum;
}

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
  KCK: "KICK",
  SNR: "SNARE",
  PRC: "PERC",
  BAS: "BASS",
  LEA: "LEAD",
  CHD: "CHORDS",
};

const HEAVY_VALUE = new Set(["pitch", "cutoff", "tone", "decay", "snap"]);

const EMPTY: (Binding | null)[] = [null, null, null, null, null, null, null, null];

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

function morphOf(path: string): MorphKind {
  const timbre = path.startsWith("sound.") || path.startsWith("filter.") || path.startsWith("send.");
  if (timbre && (path.endsWith(".value") || path.endsWith(".amount"))) return "lerp";
  return "switch";
}

function weightOf(path: string): number {
  if (path === "ratchet.count.value" || path === "repeat.value" || path === "ratchet.rate.value" || path === "rate.value") return 8;
  if (path.endsWith(".pattern")) return 1;
  if (path.endsWith(".amount")) return 1.2;
  if (path.endsWith(".cycle")) return 1.5;
  if (path.endsWith(".rotate")) return 2;
  if (path.endsWith(".probability")) return 3;
  if (path.endsWith(".hits")) return 5;
  if (path.startsWith("gen") && path.endsWith(".length")) return 6;
  if (path === "follow") return 6;
  if (path.endsWith(".value")) {
    const id = path.split(".").at(-2) ?? "";
    return HEAVY_VALUE.has(id) ? 8 : 4;
  }
  return 4;
}

function displayOf(path: string): KnobDisplay {
  if (path === "pitch.value") return "pitch";
  if (path === "octave.value") return "octave";
  if (path === "tone.value") return "chordTone";
  if (path === "rate.value") return "division";
  if (path === "root") return "note";
  if (path === "scale") return "scale";
  return "number";
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

function detentsOf(path: string, min: number, max: number): readonly number[] | undefined {
  if (path.endsWith(".cycle")) return powersOfTwo(min, max);
  if (path === "filter.cutoff.value" || path === "pitch.value") return [0.5];
  if (min < 0 && max > 0) return [0];
  return undefined;
}

function macroOf(path: string): readonly string[] | undefined {
  if (path === "gen1.probability" || path === "gen2.probability") return ["probability"];
  if (!path.endsWith(".value")) return undefined;
  const id = path.split(".").at(-2);
  if (!id) return undefined;
  return MACRO_ALSO[id] ?? [id];
}

function knob(
  path: string,
  label: string,
  min: number,
  max: number,
  step: number,
  integer = false,
  store: KnobStore = "lane",
  detents?: readonly number[],
): Binding {
  const macro = macroOf(path);
  const picked = (detents ?? detentsOf(path, min, max) ?? []).filter((value) => value >= min && value <= max);
  return {
    path,
    label,
    short: shortLabel(label),
    title: titleLabel(label),
    min,
    max,
    step,
    integer,
    store,
    morph: morphOf(path),
    weight: weightOf(path),
    display: displayOf(path),
    ...(macro ? { macro } : {}),
    ...(picked.length ? { detents: picked } : {}),
  };
}

function vpca(path: string, label: string): Binding[] {
  return [
    knob(`${path}.value`, `${label} V`, 0, 1, 0.01),
    knob(`${path}.pattern`, `${label} P`, 0, 63, 1, true),
    knob(`${path}.cycle`, `${label} C`, 1, 64, 1, true),
    knob(`${path}.amount`, `${label} A`, -1, 1, 0.01),
  ];
}

function page(id: string, title: string, groups: [string | null, string | null], group: PageGroup, bindings: (Binding | null)[]): Page {
  return { id, title, groups, group, bindings: slots(bindings) };
}

function pair(aPath: string, aLabel: string, bPath: string, bLabel: string, group: PageGroup): Page {
  return page(aPath, `${aLabel} ${bLabel}`, [aLabel, bLabel], group, [...vpca(aPath, aLabel), ...vpca(bPath, bLabel)]);
}

function genPage(which: 1 | 2): Page {
  const prefix = `gen${which}`;
  const tag = `G${which}`;
  return page(prefix, `GEN ${which}`, [`GEN ${which}`, "VEL"], "pattern", [
    knob(`${prefix}.length`, `${tag} LEN`, 0, 64, 1, true),
    knob(`${prefix}.hits`, `${tag} HIT`, 0, 64, 1, true),
    knob(`${prefix}.rotate`, `${tag} ROT`, 0, 64, 1, true),
    knob(`${prefix}.probability`, `${tag} PRB`, 0, 1, 0.01),
    ...vpca(`${prefix}.velocity`, `${tag} VEL`),
  ]);
}

function lengthPage(): Page {
  return page("length", "LENGTH", ["LENGTH", "FOLLOW"], "notes", [
    ...vpca("length", "LENGTH"),
    knob("follow", "FOLLOW", 0, 1, 0.01),
  ]);
}

function soundPages(ids: readonly string[]): Page[] {
  const pages: Page[] = [];
  for (let i = 0; i < ids.length; i += 2) {
    const a = ids[i];
    const b = ids[i + 1];
    pages.push(pair(`sound.${a}`, a.toUpperCase(), `sound.${b}`, b.toUpperCase(), "sound"));
  }
  return pages;
}

function filterPage(): Page {
  return pair("filter.cutoff", "CUTOFF", "filter.resonance", "RESO", "fx");
}

function sendPage(): Page {
  return pair("send.reverb", "REV", "send.delay", "DLY", "fx");
}

function drumPages(lane: DrumId): Page[] {
  return [
    genPage(1),
    genPage(2),
    pair("ratchet.count", "COUNT", "ratchet.rate", "RATE", "pattern"),
    ...soundPages(SOUND[lane]),
    filterPage(),
    sendPage(),
  ];
}

function pitchedPages(lane: PitchedId): Page[] {
  return [
    genPage(1),
    genPage(2),
    pair("repeat", "REPEAT", "step", "STEP", "pattern"),
    pair("pitch", "PITCH", "octave", "OCTAVE", "notes"),
    lengthPage(),
    ...soundPages(SOUND[lane]),
    filterPage(),
    sendPage(),
  ];
}

function chordPages(): Page[] {
  return [
    page("play", "PLAY", ["RATE", "GATE"], "notes", [...vpca("rate", "RATE"), ...vpca("gate", "GATE")]),
    pair("tone", "TONE", "octave", "OCTAVE", "notes"),
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

function plainPage(id: string, title: string, left: string, right: string, group: PageGroup, store: KnobStore, knobs: readonly [string, string][]): Page {
  return page(
    id,
    title,
    [left, right],
    group,
    knobs.map(([key, label]) => knob(`${id}.${key}`, label, 0, 1, 0.01, false, store)),
  );
}

function progPage(): Page {
  return page("prog", "PROG", ["WALK", "TONE"], "notes", [
    knob("start", "START", -7, 7, 1, true, "progression"),
    knob("count", "COUNT", 1, 16, 1, true, "progression"),
    knob("length", "LENGTH", 0, 4, 1, true, "progression"),
    knob("motion", "MOTION", 0, 7, 1, true, "progression"),
    knob("variation", "VARIATION", 0, 3, 1, true, "progression"),
    knob("mood", "MOOD", 0, 1, 0.01, false, "progression"),
    knob("tension", "TENSION", 0, 1, 0.01, false, "progression"),
    knob("way", "WAY", 0, 3, 1, true, "progression"),
  ]);
}

function spacePages(): Page[] {
  return [
    plainPage("reverb", "REVERB", "SIZE", "TAIL", "space", "space", [
      ["size", "SIZE"],
      ["decay", "DECAY"],
      ["damp", "DAMP"],
      ["diff", "DIFF"],
      ["pre", "PRE"],
      ["width", "WIDTH"],
      ["low", "LOW"],
      ["level", "LEVEL"],
    ]),
    plainPage("delay", "DELAY", "TIME", "ECHO", "space", "space", [
      ["time", "TIME"],
      ["feed", "FEED"],
      ["hi", "HI"],
      ["lo", "LO"],
      ["width", "WIDTH"],
      ["mod", "MOD"],
      ["rate", "RATE"],
      ["level", "LEVEL"],
    ]),
  ];
}

function mixPage(): Page {
  return page("mix", "MIXER", [null, null], "mix", [
    ...LANES.map((lane) => knob(lane, LANE_CODE[lane], 0, 1, 0.01, false, "mixer")),
    knob("master", "MASTER", 0, 1, 0.01, false, "mixer"),
  ]);
}

function globalPage(): Page {
  return page("settings", "GLOBAL", ["TIME", "FORM"], "global", [
    knob("tempo", "TEMPO", 40, 240, 1, true, "global"),
    knob("swing", "SWING", 0, 1, 0.01, false, "global"),
    knob("root", "ROOT", 0, 11, 1, true, "global"),
    knob("scale", "SCALE", 0, SCALE_IDS.length - 1, 1, true, "global"),
    knob("transpose", "TRANS", -24, 24, 1, true, "global"),
    knob("bar", "BAR", 1, 16, 1, true, "global"),
    knob("phrase", "PHRASE", 1, 64, 1, true, "global"),
    knob("seed", "SEED", 0, 999, 1, true, "global"),
  ]);
}

function macroPage(id: string, title: string, knobs: readonly [string, string][]): Page {
  return page(
    id,
    title,
    [title, null],
    "macro",
    knobs.map(([key, label]) => knob(`macro.${key}`, label, -1, 1, 0.01, false, "macro")),
  );
}

function perfPages(): Page[] {
  return [
    macroPage("play", "PLAY", [
      ["probability", "DENS"],
      ["repeat", "REP"],
      ["step", "STEP"],
      ["velocity", "VEL"],
      ["length", "LEN"],
      ["gate", "GATE"],
      ["rate", "RATE"],
      ["decay", "DECAY"],
    ]),
    macroPage("tone", "TONE", [
      ["cutoff", "CUT"],
      ["resonance", "RES"],
      ["drive", "DRV"],
      ["noise", "NSE"],
      ["attack", "ATK"],
      ["wave", "WAVE"],
      ["wide", "WIDE"],
      ["tone", "TONE"],
    ]),
  ];
}

/** Progression, space, mixer, global, then the two macro pages. One pad row. */
const AUX_PAGES: Page[] = [progPage(), ...spacePages(), mixPage(), globalPage(), ...perfPages()];

export function lanePages(lane: LaneId): Page[] {
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

/** Knob paths on one page, in column order. Capture spends these, not a second list. */
export function bindingPaths(page: Page): string[] {
  const paths: string[] = [];
  for (const binding of page.bindings) if (binding) paths.push(binding.path);
  return paths;
}

/** Pattern, notes, sound, or filter pages for a lane, taken from the same pages the screen shows. */
export function laneScopePaths(lane: LaneId, scope: "pattern" | "notes" | "sound" | "fx" | "all"): string[][] {
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
export function modulatorPaths(lane: LaneId, target: string): string[] {
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

export function pageGroupColor(context: ContextId, index: number): number {
  return PAGE_GROUP_COLOR[pageGroup(context, index)];
}

/** First binding with this path. Ranges are the same on every lane that has the knob. */
export function bindingFor(path: string): Binding | null {
  return byPath.get(path) ?? null;
}

for (const context of STEPS) pagesFor(context);
