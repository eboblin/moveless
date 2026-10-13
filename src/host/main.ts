import { PPQN, SAMPLE_RATE } from "../core/clock.ts";
import { defaultProject } from "../core/defaults.ts";
import { advance } from "../core/performance.ts";
import { phraseLoop, soundMotions } from "../dsp/schedule.ts";
import { packPhraseBody } from "../dsp/voice.ts";
import { reduce, type MidiMsg, type Session } from "../ui/input.ts";
import { MENU_CC, menuLed, padLeds, stepLeds, trackLeds } from "../ui/leds.ts";
import { renderScreen } from "../ui/screen.ts";
import { defaultUi } from "../ui/state.ts";
import type { Project } from "../core/types.ts";

interface HostGlobals {
  clear_screen?: () => void;
  set_pixel?: (x: number, y: number, value: number) => void;
  print?: (x: number, y: number, text: string, color: number) => void;
  fill_rect?: (x: number, y: number, w: number, h: number, value: number) => void;
  text_width?: (text: string) => number;
  move_midi_internal_send?: (packet: number[]) => void;
  host_module_set_param?: (key: string, value: string) => void;
  shadow_set_param?: (slot: number, key: string, value: string) => void;
}

function boot(): Session {
  return { project: defaultProject(), ui: defaultUi(), tick: 0, playing: true };
}

let session = boot();
let voiceOn = false;
let clockMs = 0;
let sentMs = 0;
let phraseProject: Project | null = null;
let phraseBody = "";
let phraseSent = "";
let voiceStep = -1;
let voiceMorph = false;

function sendBlock(value: string): void {
  const host = globalThis as HostGlobals;
  if (host.host_module_set_param) host.host_module_set_param("block", value);
  else host.shadow_set_param?.(0, "overtake_dsp:block", value);
}

function syncVoice(reset: boolean): void {
  const tempo = session.project.global.tempo;
  if (!session.playing) {
    if (voiceOn) sendBlock(`S|${tempo}`);
    voiceOn = false;
    phraseSent = "";
    return;
  }
  const step = Math.floor(session.tick / 48);
  const morphing = session.project.morph !== null;
  const boundary = morphing !== voiceMorph || step !== voiceStep;
  if (phraseProject !== session.project && (!morphing || boundary || reset)) {
    phraseBody = packPhraseBody(phraseLoop(session.project), soundMotions(session.project));
    phraseProject = session.project;
    phraseSent = "";
  }
  voiceStep = step;
  voiceMorph = morphing;
  const now = Date.now();
  if (reset || phraseSent !== phraseBody || now - sentMs > 400) {
    sendBlock(`P|${tempo}|${reset ? 1 : 0}|${phraseBody}`);
    phraseSent = phraseBody;
    sentMs = now;
  }
  voiceOn = true;
}

function blit(pixels: Uint8Array): void {
  const host = globalThis as HostGlobals;
  if (!host.clear_screen || !host.set_pixel) return;
  host.clear_screen();
  for (let i = 0; i < pixels.length; i++) {
    if (!pixels[i]) continue;
    host.set_pixel(i % 128, Math.floor(i / 128), 1);
  }
}

let sentSteps: number[] = [];
let sentPads: number[] = [];
let sentTracks: number[] = [];
let sentMenu = -1;
const TRACK_CC = 40;

function paint(): void {
  const screen = renderScreen(session.project, session.ui, session.tick, session.playing);
  blit(screen.pixels);
  const host = globalThis as HostGlobals;
  for (const label of screen.labels) {
    if (!label.invert) {
      host.print?.(label.x, label.y, label.text, 1);
      continue;
    }
    const width = host.text_width?.(label.text) ?? label.text.length * 6;
    host.fill_rect?.(label.x, label.y, width, 7, 1);
    host.print?.(label.x, label.y, label.text, 0);
  }
  if (!host.move_midi_internal_send) return;
  const blinkOn = Math.floor(session.tick / (PPQN / 2)) % 2 === 0;
  stepLeds(session.project, session.ui.context).forEach((led, index) => {
    const color = led.blink && !blinkOn ? 0 : led.color;
    if (sentSteps[index] === color) return;
    sentSteps[index] = color;
    host.move_midi_internal_send?.([0x09, 0x90, 16 + index, color]);
  });
  const menu = menuLed(session.ui.mode).color;
  if (sentMenu !== menu) {
    sentMenu = menu;
    host.move_midi_internal_send([0x0B, 0xB0, MENU_CC, menu]);
  }
  trackLeds(session.project, session.ui.context, session.ui.page).forEach((led, index) => {
    const color = led.blink && !blinkOn ? 0 : led.color;
    if (sentTracks[index] === color) return;
    sentTracks[index] = color;
    host.move_midi_internal_send?.([0x0B, 0xB0, TRACK_CC + index, color]);
  });
  padLeds(session.project, session.ui.mode, session.ui).forEach((led, index) => {
    const color = led.blink && !blinkOn ? 0 : led.color;
    if (sentPads[index] === color) return;
    sentPads[index] = color;
    host.move_midi_internal_send?.([0x09, 0x90, 68 + index, color]);
  });
}

function advanceClock(): void {
  const now = Date.now();
  if (!clockMs) clockMs = now;
  const dt = Math.max(0, Math.min(100, now - clockMs));
  clockMs = now;
  const starting = session.playing && !voiceOn;
  if (starting) session = { ...session, tick: 0 };
  else if (session.playing && dt > 0) {
    const samplesPerTick = (SAMPLE_RATE * 60) / (session.project.global.tempo * 192);
    session = { ...session, tick: session.tick + (dt / 1000) * SAMPLE_RATE / samplesPerTick };
  }
  session = { ...session, project: advance(session.project, session.tick) };
  syncVoice(starting);
}

export function init(): void {
  session = boot();
  voiceOn = false;
  phraseProject = null;
  phraseBody = "";
  phraseSent = "";
  voiceStep = -1;
  voiceMorph = false;
  clockMs = Date.now();
  sentMs = 0;
  sentSteps = [];
  sentPads = [];
  sentTracks = [];
  sentMenu = -1;
  syncVoice(true);
  paint();
}

export function tick(): void {
  advanceClock();
  paint();
}

export function onMidiMessageInternal(data: number[]): void {
  const status = data[0] ?? 0;
  const kind: MidiMsg["kind"] = (status & 0xf0) === 0x90 ? "note" : "cc";
  session = reduce(session, { kind, data1: data[1] ?? 0, data2: data[2] ?? 0 });
  paint();
}

const root = globalThis as HostGlobals & {
  init?: () => void;
  tick?: () => void;
  onMidiMessageInternal?: (data: number[]) => void;
};
root.init = init;
root.tick = tick;
root.onMidiMessageInternal = onMidiMessageInternal;
