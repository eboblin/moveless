import { FRAMES_PER_BLOCK, SIXTEENTH_TICKS, tickToSample } from "../core/clock.ts";
import { LANES, type LaneId, type Project } from "../core/types.ts";
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

/** Sound parameters follow their generator for the whole note. Pitch and note choice stay at note on. */
export function soundMotions(project: Project): Motion[] {
  const tempo = project.global.tempo;
  const out: Motion[] = [];
  for (const lane of LANES) {
    if (project.mute[lane]) continue;
    const steps = Math.max(1, laneSteps(project.working, lane, project.global));
    const loop = Math.max(1, tickToSample(steps * SIXTEENTH_TICKS, tempo));
    const sound = project.working[lane].sound;
    const macros = project.lock[lane] ? {} : project.macros;
    for (const id of Object.keys(sound)) {
      if (id === "pitch") continue;
      const heard = withMacro(sound[id], macros[id] ?? 0);
      const mapped = mapSound(lane, { [id]: 0 })[0];
      if (!mapped) continue;
      out.push({
        lane,
        id: mapped.id,
        value: heard.value,
        pattern: Math.round(heard.pattern),
        cycle: heard.cycle,
        amount: heard.amount,
        loop,
      });
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
