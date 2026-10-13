import { countFromUnit } from "./clock.ts";
import { generateHits } from "./events.ts";
import { evalModulated } from "./modulate.ts";
import { generatePhrase, laneSteps } from "./phrase.ts";
import { LANE_CODE, LANES, QUALITY_NAMES, type LaneId, type Project } from "./types.ts";

/** One character per sixteenth of that lane's phrase. Same generator as playback. */
export function textPreview(project: Project): string {
  const phrase = generatePhrase(project);
  return LANES.map((lane) => `${LANE_CODE[lane]} ${lineFor(project, lane, phrase.steps[lane])}`).join("\n");
}

function lineFor(project: Project, lane: LaneId, steps: number): string {
  const chars = Array.from({ length: steps }, () => "-");
  if (lane === "kick" || lane === "snare" || lane === "hat" || lane === "perc") {
    const hits = generateHits(project.working[lane].events, project.working[lane].form, steps, project.global.seed, lane, project.global.bar);
    hits.forEach((hit) => {
      const count = countFromUnit(evalModulated(project.working[lane].ratchet.count, hit.step));
      chars[hit.step] = count > 1 ? String(Math.min(9, count)) : "x";
    });
    return chars.join("");
  }
  if (lane === "bass" || lane === "lead") {
    for (const event of generatePhrase(project).lanes[lane]) {
      if (event.step < 0 || event.step >= chars.length) continue;
      if (chars[event.step] !== "-") continue;
      chars[event.step] = degreeChar(event.note, lane === "bass" ? 2 : 4, project);
    }
    return chars.join("");
  }
  for (const harm of generatePhrase(project).harmony) {
    const step = Math.floor(harm.startTick / 48);
    if (step >= 0 && step < chars.length) chars[step] = String(Math.abs(Math.round(harm.root)) % 10);
  }
  return chars.join("");
}

function degreeChar(note: number, octave: number, project: Project): string {
  const pc = note - octave * 12 - ((project.global.root + project.global.transpose) % 12);
  const scale = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10] }[project.global.scale];
  let best = 0;
  let bestDist = 99;
  for (let degree = -7; degree <= 14; degree++) {
    const idx = ((degree % scale.length) + scale.length) % scale.length;
    const oct = Math.floor(degree / scale.length);
    const semi = scale[idx] + oct * 12;
    const dist = Math.abs(semi - pc);
    if (dist < bestDist) {
      best = degree;
      bestDist = dist;
    }
  }
  if (best < 0) return "v";
  if (best > 9) return "^";
  return String(best);
}

export function chordLabels(project: Project): string[] {
  return generatePhrase(project).harmony.map((event) => `${event.root}:${QUALITY_NAMES[event.quality]}`);
}

export function phraseStepsOf(project: Project, lane: LaneId): number {
  return laneSteps(project.working, lane, project.global);
}
