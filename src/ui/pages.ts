import { sharedParamIds } from "../core/performance.ts";
import { LANE_CODE, SCALE_IDS, SOUND, type ContextId, type LaneId } from "../core/types.ts";

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
  return { id: aPath, title: `${aLabel} ${bLabel}`, bindings: slots([...vpca(aPath, aLabel), ...vpca(bPath, bLabel)]) };
}

function genPage(which: 1 | 2): Page {
  const prefix = `gen${which}`;
  const tag = `G${which}`;
  return {
    id: prefix,
    title: `GEN ${which}`,
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
  return {
    id: "pitch",
    title: "PITCH",
    bindings: slots([
      ...vpca("degree", "DEGREE"),
      num("range.value", "RANGE V", 0, 1, 0.01),
      num("range.amount", "RANGE A", -1, 1, 0.01),
      num("follow", "FOLLOW", 0, 1, 0.01),
      null,
    ]),
  };
}

function lengthPage(): Page {
  return {
    id: "length",
    title: "LENGTH",
    bindings: slots(vpca("length", "LENGTH")),
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

function playPage(): Page {
  return {
    id: "play",
    title: "PLAY",
    bindings: slots([
      num("play.mode", "MODE", 0, 3, 1, true),
      num("play.rate", "RATE", 0, 5, 1, true),
      num("play.gate", "GATE", 0, 1, 0.01),
      num("play.octaves", "OCT", 1, 4, 1, true),
      num("play.spread", "SPREAD", 0, 1, 0.01),
      num("play.flow", "FLOW", 0, 1, 0.01),
      num("play.strum", "STRUM", 0, 1, 0.01),
      num("play.direction", "DIR", 0, 2, 1, true),
    ]),
  };
}

export function lanePages(lane: LaneId): Page[] {
  if (lane === "chords") {
    return [
      pair("change", "CHANGE", "length", "LENGTH"),
      pair("motion", "MOTION", "variation", "VARIATION"),
      pair("mood", "MOOD", "tension", "TENSION"),
      playPage(),
      ...soundPages(SOUND.chords),
    ];
  }
  const pitched = lane === "bass" || lane === "lead";
  return [
    genPage(1),
    genPage(2),
    ...(pitched
      ? [pitchPage(), lengthPage(), pair("repeat", "REPEAT", "step", "STEP")]
      : [pair("ratchet.count", "COUNT", "ratchet.rate", "RATE")]),
    ...soundPages(SOUND[lane]),
  ];
}

export function mixPage(): Page {
  const lanes: LaneId[] = ["kick", "snare", "hat", "perc", "bass", "lead", "chords"];
  return {
    id: "mix",
    title: "MIXER",
    bindings: slots([
      ...lanes.map((lane) => num(lane, LANE_CODE[lane], 0, 1, 0.01)),
      num("master", "MASTER", 0, 1, 0.01),
    ]),
  };
}

export function globalPages(): Page[] {
  const settings: Page = {
    id: "settings",
    title: "GLOBAL",
    bindings: slots([
      num("tempo", "TEMPO", 40, 240, 1, true),
      num("swing", "SWING", 0, 1, 0.01),
      num("root", "ROOT", 0, 11, 1, true),
      num("scale", "SCALE", 0, SCALE_IDS.length - 1, 1, true),
      num("transpose", "TRANS", -24, 24, 1, true),
      num("bar", "BAR", 1, 16, 1, true),
      num("phrase", "PHRASE", 1, 64, 1, true),
      num("seed", "SEED", 0, 9999, 1, true),
    ]),
  };
  const ids = sharedParamIds();
  const macros: Page[] = [];
  for (let i = 0; i < ids.length; i += 8) {
    const slice = ids.slice(i, i + 8);
    macros.push({
      id: `macro-${i / 8}`,
      title: "MACRO",
      bindings: slots(slice.map((id) => num(`macro.${id}`, id.toUpperCase(), -1, 1, 0.01))),
    });
  }
  return [settings, ...macros];
}

export function pagesFor(context: ContextId): Page[] {
  if (context === "mix") return [mixPage()];
  if (context === "global") return globalPages();
  return lanePages(context);
}

export function pageCount(context: ContextId): number {
  return pagesFor(context).length;
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
  if (context === "global") return index === 0 ? "global" : "macro";
  if (context === "chords") return index < 4 ? "notes" : "sound";
  if (context === "bass" || context === "lead") {
    if (index < 2) return "pattern";
    if (index < 5) return "notes";
    return "sound";
  }
  return index < 3 ? "pattern" : "sound";
}

export function pageGroupColor(context: ContextId, index: number): number {
  return PAGE_GROUP_COLOR[pageGroup(context, index)];
}
