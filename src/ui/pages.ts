import { isPitched, LANE_CODE, SCALE_IDS, SOUND, type ContextId, type LaneId } from "../core/types.ts";

export interface Binding {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
}

export interface Page {
  id: string;
  title: string;
  /** Names for the left and right knob fours; shown right-aligned in each header half. */
  groups: [string | null, string | null];
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

function pair(aPath: string, aLabel: string, bPath: string, bLabel: string): Page {
  return {
    id: aPath,
    title: `${aLabel} ${bLabel}`,
    groups: [aLabel, bLabel],
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
  return pair("pitch", "PITCH", "octave", "OCTAVE");
}

function lengthPage(): Page {
  return {
    id: "length",
    title: "LENGTH",
    groups: ["LENGTH", "FOLLOW"],
    bindings: slots([...vpca("length", "LENGTH"), num("follow", "FOLLOW", 0, 1, 0.01)]),
  };
}

function soundPages(ids: readonly string[]): Page[] {
  const pages: Page[] = [];
  for (let i = 0; i < ids.length; i += 2) {
    const a = ids[i];
    const b = ids[i + 1];
    pages.push(pair(`sound.${a}`, a.toUpperCase(), `sound.${b}`, b.toUpperCase()));
  }
  return pages;
}

function progPage(): Page {
  return {
    id: "prog",
    title: "PROG",
    groups: ["WALK", "TONE"],
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
    bindings: slots([...vpca("rate", "RATE"), ...vpca("gate", "GATE")]),
  };
}

export function lanePages(lane: LaneId): Page[] {
  if (lane === "chords") {
    return [progPage(), playPage(), pair("tone", "TONE", "octave", "OCTAVE"), ...soundPages(SOUND.chords)];
  }
  const pitched = lane === "bass" || lane === "lead";
  return [
    genPage(1),
    genPage(2),
    ...(pitched
      ? [pair("repeat", "REPEAT", "step", "STEP"), pitchPage(), lengthPage()]
      : [pair("ratchet.count", "COUNT", "ratchet.rate", "RATE")]),
    ...soundPages(SOUND[lane]),
  ];
}

export function mixPage(): Page {
  const lanes: LaneId[] = ["kick", "snare", "hat", "perc", "bass", "lead", "chords"];
  return {
    id: "mix",
    title: "MIXER",
    groups: [null, null],
    bindings: slots([
      ...lanes.map((lane) => num(lane, LANE_CODE[lane], 0, 1, 0.01)),
      num("master", "MASTER", 0, 1, 0.01),
    ]),
  };
}

export function globalPages(): Page[] {
  return [
    {
      id: "settings",
      title: "GLOBAL",
      groups: ["TIME", "FORM"],
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
  const pages = context === "mix"
    ? [mixPage()]
    : context === "global"
      ? globalPages()
      : context === "perf"
        ? perfPages()
        : lanePages(context);
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

/** Pattern, notes, or sound pages for a lane, taken from the same pages the screen shows. */
export function laneScopePaths(lane: LaneId, scope: "pattern" | "notes" | "sound" | "all"): string[][] {
  const pages = pagesFor(lane);
  const picked: string[][] = [];
  pages.forEach((page, index) => {
    const group = pageGroup(lane, index);
    if (group !== "pattern" && group !== "notes" && group !== "sound") return;
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

export type PageGroup = "pattern" | "notes" | "sound" | "global" | "macro" | "mix";

/** Move pad colors. Pattern, notes and sound stay the same on every lane. */
export const PAGE_GROUP_COLOR: Record<PageGroup, number> = {
  pattern: 3,
  notes: 14,
  sound: 20,
  global: 8,
  macro: 22,
  mix: 120,
};

export function pageGroup(context: ContextId, index: number): PageGroup {
  if (context === "mix") return "mix";
  if (context === "global") return "global";
  if (context === "perf") return "macro";
  if (context === "chords") return index < 3 ? "notes" : "sound";
  if (context === "bass" || context === "lead") {
    if (index < 3) return "pattern";
    if (index < 5) return "notes";
    return "sound";
  }
  return index < 3 ? "pattern" : "sound";
}

export function pageGroupColor(context: ContextId, index: number): number {
  return PAGE_GROUP_COLOR[pageGroup(context, index)];
}
