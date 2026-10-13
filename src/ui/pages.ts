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

function eventPage(part: "a" | "b", title: string): Page {
  const prefix = `events.${part}`;
  const names = ["G1 LV", "G1 CY", "G1 OF", "G2 LV", "G2 CY", "G2 OF"];
  const keys = ["g1.level", "g1.cycle", "g1.offset", "g2.level", "g2.cycle", "g2.offset"];
  return {
    id: title,
    title,
    bindings: slots(keys.map((key, index) => {
      const integer = !key.endsWith("level");
      const min = key.endsWith("level") ? 0 : key.endsWith("offset") ? 0 : 1;
      const max = key.endsWith("level") ? 1 : 64;
      return num(`${prefix}.${key}`, names[index], min, max, integer ? 1 : 0.01, integer);
    })),
  };
}

function formPage(withFollow: boolean): Page {
  const bindings: Binding[] = [
    num("form.length", "LENGTH", 1, 32, 1, true),
    num("form.abSplit", "A/B", 0, 1, 0.01),
    num("form.repeats", "REPEATS", 1, 16, 1, true),
    num("form.varEvery", "VAR EV", 1, 32, 1, true),
    num("form.varDiv", "VAR DIV", 1, 64, 1, true),
    num("form.varCount", "VAR N", 1, 8, 1, true),
    num("form.varAmount", "VAR AMT", 0, 1, 0.01),
  ];
  if (withFollow) bindings.push(num("form.follow", "FOLLOW", 0, 1, 0.01));
  return { id: "form", title: "FORM", bindings: slots(bindings) };
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
    eventPage("a", "EVENT A"),
    eventPage("b", "EVENT B"),
    formPage(pitched),
    pitched ? pair("degree", "DEGREE", "range", "RANGE") : pair("ratchet.count", "COUNT", "ratchet.rate", "RATE"),
    ...(pitched ? [pair("length", "LENGTH", "velocity", "VELOCITY"), pair("repeat", "REPEAT", "step", "STEP")] : []),
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
    if (index < 3) return "pattern";
    if (index < 6) return "notes";
    return "sound";
  }
  return index < 4 ? "pattern" : "sound";
}

export function pageGroupColor(context: ContextId, index: number): number {
  return PAGE_GROUP_COLOR[pageGroup(context, index)];
}
