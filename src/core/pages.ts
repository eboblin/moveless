import { LANE_CODE, LANES, SCALE_IDS, SOUND, STEPS, type ContextId, type LaneId } from "./types.ts";

export interface Binding {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
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

const EMPTY: (Binding | null)[] = [null, null, null, null, null, null, null, null];

function slots(bindings: (Binding | null)[]): (Binding | null)[] {
  const out = EMPTY.slice();
  bindings.forEach((binding, index) => {
    if (index < 8) out[index] = binding;
  });
  return out;
}

function num(path: string, label: string, min: number, max: number, step: number, integer = false): Binding {
  return { path, label, min, max, step, integer };
}

function vpca(path: string, label: string): Binding[] {
  return [
    num(`${path}.value`, `${label} V`, 0, 1, 0.01),
    num(`${path}.pattern`, `${label} P`, 0, 63, 1, true),
    num(`${path}.cycle`, `${label} C`, 1, 64, 1, true),
    num(`${path}.amount`, `${label} A`, -1, 1, 0.01),
  ];
}

function pair(aPath: string, aLabel: string, bPath: string, bLabel: string, group: PageGroup): Page {
  return {
    id: aPath,
    title: `${aLabel} ${bLabel}`,
    groups: [aLabel, bLabel],
    group,
    bindings: slots([...vpca(aPath, aLabel), ...vpca(bPath, bLabel)]),
  };
}

function genPage(which: 1 | 2): Page {
  const prefix = `gen${which}`;
  const tag = `G${which}`;
  return {
    id: prefix,
    title: `GEN ${which}`,
    groups: [`GEN ${which}`, "VEL"],
    group: "pattern",
    bindings: slots([
      num(`${prefix}.length`, `${tag} LEN`, 0, 64, 1, true),
      num(`${prefix}.hits`, `${tag} HIT`, 0, 64, 1, true),
      num(`${prefix}.rotate`, `${tag} ROT`, 0, 64, 1, true),
      num(`${prefix}.probability`, `${tag} PRB`, 0, 1, 0.01),
      ...vpca(`${prefix}.velocity`, `${tag} VEL`),
    ]),
  };
}

function pitchPage(): Page {
  return pair("pitch", "PITCH", "octave", "OCTAVE", "notes");
}

function lengthPage(): Page {
  return {
    id: "length",
    title: "LENGTH",
    groups: ["LENGTH", "FOLLOW"],
    group: "notes",
    bindings: slots([...vpca("length", "LENGTH"), num("follow", "FOLLOW", 0, 1, 0.01)]),
  };
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

function progPage(): Page {
  return {
    id: "prog",
    title: "PROG",
    groups: ["WALK", "TONE"],
    group: "notes",
    bindings: slots([
      num("start", "START", -7, 7, 1, true),
      num("count", "COUNT", 1, 16, 1, true),
      num("length", "LENGTH", 0, 4, 1, true),
      num("motion", "MOTION", 0, 7, 1, true),
      num("variation", "VARIATION", 0, 3, 1, true),
      num("mood", "MOOD", 0, 1, 0.01),
      num("tension", "TENSION", 0, 1, 0.01),
      num("way", "WAY", 0, 3, 1, true),
    ]),
  };
}

function playPage(): Page {
  return {
    id: "play",
    title: "PLAY",
    groups: ["RATE", "GATE"],
    group: "notes",
    bindings: slots([...vpca("rate", "RATE"), ...vpca("gate", "GATE")]),
  };
}

function filterPage(): Page {
  return pair("filter.cutoff", "CUTOFF", "filter.resonance", "RESO", "fx");
}

function sendPage(): Page {
  return pair("send.reverb", "REV", "send.delay", "DLY", "fx");
}

export function lanePages(lane: LaneId): Page[] {
  if (lane === "chords") {
    return [playPage(), pair("tone", "TONE", "octave", "OCTAVE", "notes"), ...soundPages(SOUND.chords), filterPage(), sendPage()];
  }
  const pitched = lane === "bass" || lane === "lead";
  return [
    genPage(1),
    genPage(2),
    ...(pitched
      ? [pair("repeat", "REPEAT", "step", "STEP", "pattern"), pitchPage(), lengthPage()]
      : [pair("ratchet.count", "COUNT", "ratchet.rate", "RATE", "pattern")]),
    ...soundPages(SOUND[lane]),
    filterPage(),
    sendPage(),
  ];
}

export function mixPage(): Page {
  return {
    id: "mix",
    title: "MIXER",
    groups: [null, null],
    group: "mix",
    bindings: slots([
      ...LANES.map((lane) => num(lane, LANE_CODE[lane], 0, 1, 0.01)),
      num("master", "MASTER", 0, 1, 0.01),
    ]),
  };
}

export function progPages(): Page[] {
  return [progPage()];
}

/** Progression, space, mixer, global, then the two macro pages. One pad row. */
export function auxPages(): Page[] {
  return [...progPages(), ...spacePages(), mixPage(), ...globalPages(), ...perfPages()];
}

export function spacePages(): Page[] {
  return [
    plainPage("reverb", "REVERB", "SIZE", "TAIL", "space", [
      ["size", "SIZE"],
      ["decay", "DECAY"],
      ["damp", "DAMP"],
      ["diff", "DIFF"],
      ["pre", "PRE"],
      ["width", "WIDTH"],
      ["low", "LOW"],
      ["level", "LEVEL"],
    ]),
    plainPage("delay", "DELAY", "TIME", "ECHO", "space", [
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

function plainPage(id: string, title: string, left: string, right: string, group: PageGroup, knobs: readonly [string, string][]): Page {
  return {
    id,
    title,
    groups: [left, right],
    group,
    bindings: slots(knobs.map(([key, label]) => num(`${id}.${key}`, label, 0, 1, 0.01))),
  };
}

export function globalPages(): Page[] {
  return [
    {
      id: "settings",
      title: "GLOBAL",
      groups: ["TIME", "FORM"],
      group: "global",
      bindings: slots([
        num("tempo", "TEMPO", 40, 240, 1, true),
        num("swing", "SWING", 0, 1, 0.01),
        num("root", "ROOT", 0, 11, 1, true),
        num("scale", "SCALE", 0, SCALE_IDS.length - 1, 1, true),
        num("transpose", "TRANS", -24, 24, 1, true),
        num("bar", "BAR", 1, 16, 1, true),
        num("phrase", "PHRASE", 1, 64, 1, true),
        num("seed", "SEED", 0, 999, 1, true),
      ]),
    },
  ];
}

function macroPage(id: string, title: string, knobs: readonly [string, string][]): Page {
  return {
    id,
    title,
    groups: [title, null],
    group: "macro",
    bindings: slots(knobs.map(([key, label]) => num(`macro.${key}`, label, -1, 1, 0.01))),
  };
}

export function perfPages(): Page[] {
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
      ["shape", "SHAPE"],
      ["detune", "DET"],
      ["tone", "TONE"],
    ]),
  ];
}

const pageCache = new Map<ContextId, Page[]>();

export function pagesFor(context: ContextId): Page[] {
  const hit = pageCache.get(context);
  if (hit) return hit;
  const pages = context === "aux" ? auxPages() : lanePages(context);
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
  pages.forEach((page, index) => {
    const group = pageGroup(lane, index);
    if (group !== "pattern" && group !== "notes" && group !== "sound" && group !== "fx") return;
    if (scope !== "all" && group !== scope) return;
    picked.push(bindingPaths(page));
  });
  return picked;
}

/** Paths of one generator. A paired page contributes only the named modulator. */
export function modulatorPaths(lane: LaneId, target: string): string[] {
  if (target === "gen1" || target === "gen2") {
    const page = pagesFor(lane).find((item) => item.id === target);
    return page ? bindingPaths(page) : [];
  }
  const prefix = `${target}.`;
  const paths: string[] = [];
  for (const page of pagesFor(lane)) {
    for (const binding of page.bindings) {
      if (binding && (binding.path === target || binding.path.startsWith(prefix))) paths.push(binding.path);
    }
  }
  return paths;
}

export function pageGroup(context: ContextId, index: number): PageGroup {
  const pages = pagesFor(context);
  const page = pages[index] ?? pages[pages.length - 1];
  return page?.group ?? "pattern";
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

export function pageGroupColor(context: ContextId, index: number): number {
  return PAGE_GROUP_COLOR[pageGroup(context, index)];
}

const CATALOG: readonly ContextId[] = STEPS;

/** First binding with this path. Ranges are the same on every lane that has the knob. */
export function bindingFor(path: string): Binding | null {
  for (const context of CATALOG) {
    for (const page of pagesFor(context)) {
      for (const binding of page.bindings) {
        if (binding?.path === path) return binding;
      }
    }
  }
  return null;
}
