import { clamp01, FRAMES_PER_BLOCK, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { LANES, type LaneId, type Project } from "../core/types.ts";
import { morphEndpoints } from "../core/morph.ts";
import { withMacro } from "../core/modulate.ts";
import { generatePhrase, laneSteps } from "../core/phrase.ts";
import { mapSound, type EngineParam } from "./map.ts";

export interface BlockEvent {
  sampleOffset: number;
  lane: LaneId;
  note: number;
  velocity: number;
  lengthTicks: number;
  params: EngineParam[];
}

/** One hit inside a lane loop. `sample` is the offset from the start of that loop. */
export interface LoopEvent {
  sample: number;
  loop: number;
  lane: LaneId;
  note: number;
  velocity: number;
  lengthTicks: number;
  params: EngineParam[];
}

/** A sound generator the voice rereads on every sample. */
export interface Motion {
  lane: LaneId;
  id: string;
  value: number;
  pattern: number;
  cycle: number;
  amount: number;
  loop: number;
  /** Second modulator while a morph is blending this sound. */
  blend?: { value: number; pattern: number; cycle: number; amount: number; t: number };
}

/** The whole phrase, once around. Each lane repeats on its own length. */
export function phraseLoop(project: Project): LoopEvent[] {
  const phrase = generatePhrase(project);
  const tempo = project.global.tempo;
  const out: LoopEvent[] = [];
  for (const lane of LANES) {
    if (project.mute[lane]) continue;
    const steps = Math.max(1, phrase.steps[lane]);
    const loop = Math.max(1, tickToSample(steps * SIXTEENTH_TICKS, tempo));
    const gain = project.mixer[lane] * project.mixer.master;
    for (const event of phrase.lanes[lane]) {
      const sample = ((event.sample % loop) + loop) % loop;
      const velocity = Math.max(1, Math.min(127, Math.round(event.velocity * gain * 127)));
      out.push({
        sample,
        loop,
        lane,
        note: event.note,
        velocity,
        lengthTicks: event.lengthTicks,
        params: mapSound(lane, event.sound),
      });
    }
  }
  return out;
}

/** Sound parameters follow their generator for the whole note. Note pitch stays at note on. During a morph the same generators glide from one scene's timbre to the other's. */
export function soundMotions(project: Project): Motion[] {
  const tempo = project.global.tempo;
  const morph = project.morph;
  const target = morph ? project.journal.find((scene) => scene.id === morph.targetId) : undefined;
  const ends = morph && target ? morphEndpoints(project, target.lanes) : null;
  const t = morph?.t ?? 0;
  const heardSteps = ends ? generatePhrase(project).steps : null;
  const out: Motion[] = [];
  for (const lane of LANES) {
    if (project.mute[lane]) continue;
    const steps = Math.max(1, heardSteps ? heardSteps[lane] : laneSteps(project.working, lane, project.global));
    const loop = Math.max(1, tickToSample(steps * SIXTEENTH_TICKS, tempo));
    const sound = ends ? ends.from[lane].sound : project.working[lane].sound;
    const other = ends ? ends.to[lane].sound : null;
    const macros = project.lock[lane] ? {} : project.macros;
    for (const id of Object.keys(sound)) {
      if (id === "pitch") continue;
      const heard = withMacro(sound[id], macros[id] ?? 0);
      const mapped = mapSound(lane, { [id]: 0 })[0];
      if (!mapped) continue;
      const motion: Motion = {
        lane,
        id: mapped.id,
        value: heard.value,
        pattern: Math.round(heard.pattern),
        cycle: heard.cycle,
        amount: heard.amount,
        loop,
      };
      if (other?.[id]) {
        const toward = withMacro(other[id], macros[id] ?? 0);
        if (heard.amount === 0 && toward.amount === 0) {
          motion.value = clamp01((1 - t) * heard.value + t * toward.value);
        } else {
          motion.blend = {
            value: toward.value,
            pattern: Math.round(toward.pattern),
            cycle: toward.cycle,
            amount: toward.amount,
            t,
          };
        }
      }
      out.push(motion);
    }
  }
  return out;
}

/** Events whose sample falls in the 128-frame block that starts at `tick`. */
export function eventsInBlock(project: Project, tick: number): BlockEvent[] {
  const phrase = generatePhrase(project);
  const start = tickToSample(tick, project.global.tempo);
  const end = start + FRAMES_PER_BLOCK;
  const out: BlockEvent[] = [];
  for (const lane of LANES) {
    if (project.mute[lane]) continue;
    const gain = project.mixer[lane] * project.mixer.master;
    for (const event of phrase.lanes[lane]) {
      if (event.sample < start || event.sample >= end) continue;
      const velocity = Math.max(1, Math.min(127, Math.round(event.velocity * gain * 127)));
      out.push({
        sampleOffset: event.sample - start,
        lane,
        note: event.note,
        velocity,
        lengthTicks: event.lengthTicks,
        params: mapSound(lane, event.sound),
      });
    }
  }
  return out;
}
