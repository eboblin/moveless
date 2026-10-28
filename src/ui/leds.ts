import { morphProgress } from "../core/morph.ts";
import { sceneColor, journalPadIds, laneHeard, setPadIds } from "../core/performance.ts";
import {
  RANDOMIZE_DEPTHS,
  RANDOMIZE_SCOPES,
  isDrum,
  isLane,
  LANES,
  STEP_COUNT,
  contextAtStep,
  TRANSITIONS,
  WANDERS,
  type ContextId,
  type LaneId,
  type PatternId,
  type Project,
} from "../core/types.ts";
import { livePage, pageCount, pageGroupColor, scopeIncludesPage } from "../core/pages.ts";
import { depthTouchesPath } from "../core/randomize.ts";
import { DECK_GROUPS, GROUP_PAD, fieldAt, groupAt, type DeckKnobs } from "../core/deck.ts";
import { patternPadsVisible, peekKind, type FaceMode } from "./state.ts";

export const LED = {
  off: 0,
  red: 127,
  yellow: 8,
  purple: 22,
  lock: 125,
  /** Move RGB palette. Same index Push calls WHITE_MIDI_VALUE. */
  white: 122,
  /** Unsaved working state when journal/set has no scenes yet. */
  working: 8,
} as const;

/** Dark partner of the standard red. Pure red 127 has none of its own. */
const DIM_RED = 66;

/** Dark navy partner of lock blue. The 1–26 table and red do not cover 125. */
const DIM_LOCK = 104;

/**
 * Near-black palette index. Channel 0 with velocity 0 clears the LED and
 * stops a pulse, so a blink cannot latch black itself.
 */
const NEAR_OFF = 124;

export type LedFamily = "red" | "yellow" | "purple" | "lock" | "green" | "off";

export interface Led {
  family: LedFamily;
  color: number;
  blink: boolean;
  /** Second phase of a blink. Omitted means off. */
  blinkTo?: number;
}

const COLOR: Record<LedFamily, number> = {
  off: LED.off,
  red: LED.red,
  yellow: LED.yellow,
  purple: LED.purple,
  lock: LED.lock,
  green: 9,
};

export function laneFamily(lane: LaneId): "red" | "yellow" {
  return isDrum(lane) ? "red" : "yellow";
}

export function stepLed(project: Project, context: ContextId, lane: PatternId): Led {
  const current = context === lane;
  const family = project.lock[lane] ? "lock" : lane === "fx" ? "green" : laneFamily(lane);
  // The selected step blinks in every mute, solo and lock state, so the lane you are on stays visible.
  if (current) return led(family, true);
  if (lane === "fx") return led(project.mute.fx ? "off" : family, false);
  if (!laneHeard(project, lane)) return led("off", false);
  return led(family, false);
}

export function auxLed(current: boolean): Led {
  return led("purple", current);
}

export function stepLeds(project: Project, context: ContextId): Led[] {
  const out: Led[] = [];
  for (let index = 0; index < STEP_COUNT; index++) {
    const id = contextAtStep(index);
    if (!id) out.push(led("off", false));
    else if (isLane(id)) out.push(stepLed(project, context, id));
    else out.push(auxLed(context === id));
  }
  return out;
}

/** Menu is a white button. Lit in Journal, dark in Set. */
export function menuLed(mode: "journal" | "set"): number {
  return mode === "journal" ? PLAY_LED_ON : 0;
}

/** Plus steps toward a higher index, minus toward a lower one. Bright only when that neighbor exists. */
export function directionLit(index: number, count: number): { up: number; down: number } {
  return {
    up: index < count - 1 ? PLAY_LED_ON : 0,
    down: index > 0 ? PLAY_LED_ON : 0,
  };
}

/** Bright step of a single-color button. Play cannot take a palette color. */
export const PLAY_LED_ON = 0x7c;

/** Lit while a white-button mode is held or latched. */
export function modeButtonLed(active: boolean): number {
  return active ? PLAY_LED_ON : 0;
}

/** Mute or Capture. Bright while that mode is held, latched, or showing under the finger. */
export function faceButtonLed(
  face: FaceMode | null,
  latch: FaceMode | null,
  held: FaceMode | null,
  which: FaceMode,
): number {
  return modeButtonLed(face === which || latch === which || held === which);
}

/** Lit while the transport runs, dark when it is stopped. */
export function playLed(playing: boolean): number {
  return playing ? PLAY_LED_ON : 0;
}

/** A stored bookmark lights its track button in the same colour as that page's pad. The one matching the screen blinks. */
export function trackLeds(project: Project, context: ContextId, page: number): Led[] {
  return project.bookmarks.map((ref) => {
    if (!ref) return led("off", false);
    return {
      family: "yellow",
      color: pageGroupColor(ref.context, ref.page),
      blink: ref.context === context && ref.page === page,
    };
  });
}

export interface PadSurface {
  wheelTouch?: boolean;
  randomizeLatched?: boolean;
  sampleHeld?: boolean;
  sampleLatched?: boolean;
  face?: FaceMode | null;
  heldContext?: ContextId | null;
  heldPage?: number | null;
  context?: ContextId;
  page?: number;
  lanePages?: Partial<Record<ContextId, number>>;
  copyHeld?: boolean;
  journalPage?: number;
}

/**
 * Playing and morph-target pads share one pulse. Target also shades
 * dark→dim→bright by morph progress. An empty journal/set still shows pad 0 as the
 * current working scene. Where those pads are showing, Sample lifts the first 24 patterns
 * one row and puts Transition and Wander on the bottom row.
 * Jog touch or a latched jog click shows randomize instead, so the Sample row stays hidden.
 * Mixer and DJ FX take every pad. On the purple lane the same latch draws the page row
 * and leaves the randomize rows off.
 */
export function padLeds(project: Project, mode: "journal" | "set", surface?: PadSurface, tick = 0): Led[] {
  const context = surface?.context ?? "kick";
  const page = surface?.page ?? 0;
  const onAux = context === "aux" || surface?.heldContext === "aux";
  const auxPages = context === "aux" && !!(surface?.wheelTouch || surface?.randomizeLatched);
  const scenes = scenePadLeds(project, mode, tick, surface?.journalPage ?? 0, surface?.copyHeld ?? false);
  if (surface?.face === "mixer") return mutePeekLeds(project);
  if (surface?.face === "deck") return deckPadLeds(scenes, project.deck);
  if (!onAux && (surface?.wheelTouch || surface?.randomizeLatched)) return randomizePadLeds(project, context, page);
  let leds: Led[];
  if (surface?.heldContext) {
    const shown = surface.heldPage ?? surface.lanePages?.[surface.heldContext] ?? (surface.heldContext === context ? page : -1);
    leds = pageOverlay(scenes, surface.heldContext, shown, surface.heldContext === "aux" ? 1 : 2);
  } else {
    leds = auxPages ? pageOverlay(scenes, "aux", page, 1) : scenes;
  }
  if (peekKind(surface ?? {}) === "sample" && patternPadsVisible({ ...surface, context, page })) {
    const lifted = liftPatterns(scenes, project);
    if (surface?.heldContext) {
      const shown = surface.heldPage ?? surface.lanePages?.[surface.heldContext] ?? (surface.heldContext === context ? page : -1);
      return pageOverlay(lifted, surface.heldContext, shown, surface.heldContext === "aux" ? 1 : 2);
    }
    if (auxPages) return pageOverlay(lifted, "aux", page, 1);
    return lifted;
  }
  return leds;
}

function deckPadLeds(scenes: Led[], deck: DeckKnobs): Led[] {
  const focus = DECK_GROUPS[deck.focus] ?? "rpt";
  const hue = GROUP_PAD.find((pad) => pad.id === focus)?.hue ?? 3;
  const cell = deck.cells[DECK_GROUPS.indexOf(focus)] ?? { x: 0, y: 0 };
  for (let index = 0; index < 32; index++) {
    const group = groupAt(index);
    if (group) {
      const color = GROUP_PAD.find((pad) => pad.id === group)?.hue ?? hue;
      scenes[index] = { family: "yellow", color: group === focus ? color : offColor(color), blink: false };
      continue;
    }
    const field = fieldAt(index);
    if (!field) continue;
    const active = field.x === cell.x && field.y === cell.y;
    scenes[index] = { family: "yellow", color: active ? hue : offColor(hue), blink: false };
  }
  return scenes;
}

/** Same lamp the lane step uses: drums red, melody yellow, fx green, lock blue. */
function laneLamp(lane: LaneId | "fx"): { family: LedFamily; color: number } {
  if (lane === "fx") return { family: "green", color: COLOR.green };
  const family = laneFamily(lane);
  return { family, color: COLOR[family] };
}

/**
 * Lit in the lane colour, or fully dark. A dim shade of the same hue is too close
 * to the bright one on these pads, so off has to be black.
 */
function flagLed(family: LedFamily, color: number, on: boolean): Led {
  return on ? { family, color, blink: false } : led("off", false);
}

function mutePeekLeds(project: Project): Led[] {
  const out = Array.from({ length: 32 }, () => led("off", false));
  LANES.forEach((lane, col) => {
    const lamp = laneLamp(lane);
    out[24 + col] = flagLed(lamp.family, lamp.color, !project.mute[lane]);
    out[16 + col] = flagLed(lamp.family, lamp.color, project.solo[lane]);
    out[8 + col] = flagLed("lock", LED.lock, project.lock[lane]);
  });
  const fxCol = LANES.length;
  const fx = laneLamp("fx");
  out[24 + fxCol] = flagLed(fx.family, fx.color, !project.mute.fx);
  out[8 + fxCol] = flagLed("lock", LED.lock, project.lock.fx);
  return out;
}

/** First 24 patterns move up one row. The bottom row is transition, then wander with Off first. */
function liftPatterns(scenes: Led[], project: Project): Led[] {
  const out = Array.from({ length: 32 }, () => led("off", false));
  for (let index = 0; index < 24; index++) out[8 + index] = scenes[index] ?? led("off", false);
  TRANSITIONS.forEach((id, col) => {
    out[col] = choiceLed("yellow", LED.yellow, project.transition === id);
  });
  out[4] = choiceLed("purple", LED.purple, project.wander === null);
  WANDERS.forEach((id, col) => {
    out[5 + col] = choiceLed("purple", LED.purple, project.wander === id);
  });
  return out;
}

/** Selected choice at full colour. The others sit at the dark partner, and none of them blink. */
function choiceLed(family: LedFamily, color: number, selected: boolean): Led {
  const dim = color === LED.red ? DIM_RED : shadeColor(color, 0.2);
  return { family, color: selected ? color : dim, blink: false };
}

/**
 * Top two rows. Outside the current scope or depth a page is dim.
 * A page Loop will rewrite is bright.
 * The current page always blinks, to the dark partner of the colour it is showing.
 */
function paintRandomizePages(out: Led[], project: Project, context: ContextId, page: number): void {
  const count = pageCount(context);
  for (let index = 0; index < count && index < 16; index++) {
    const slot = index < 8 ? 24 + index : 16 + (index - 8);
    const color = pageGroupColor(context, index);
    const current = index === page;
    const zone = randomizeTouchesPage(project, context, index, page);
    const shown = zone ? color : offColor(color);
    const second = offColor(color);
    out[slot] = {
      family: "yellow",
      color: shown,
      blink: current,
      blinkTo: current ? (zone ? second || (shown === 124 ? 123 : 124) : LED.off) : undefined,
    };
  }
}

/** Pages Loop will rewrite under the current scope and depth. */
function randomizeTouchesPage(project: Project, context: ContextId, index: number, page: number): boolean {
  if (!scopeIncludesPage(project.randomizeScope, context, index, page)) return false;
  const item = livePage(project, context, index);
  if (!item) return false;
  return item.bindings.some((binding) => binding && depthTouchesPath(binding.path, project.randomizeDepth));
}

/**
 * Move palette colours 1–26 have dim/dark partners at 63+2c / 64+2c.
 * amount 0 = off; (0,1/3) = dark; [1/3,2/3) = dim; [2/3,1] = bright.
 */
/**
 * Lamp step while a morph is running. 0 is no morph. 1, 2 and 3 are the
 * dark, dim and bright bands of {@link shadeColor}, including the armed floor.
 */
export function sceneShadeStep(project: Project, tick: number): number {
  const morph = project.morph;
  if (!morph) return 0;
  const amount = Math.max(morphProgress(morph, tick), 1 / 6);
  if (amount < 1 / 3) return 1;
  if (amount < 2 / 3) return 2;
  return 3;
}

export function shadeColor(color: number, amount: number): number {
  if (amount <= 0) return 0;
  if (color < 1 || color > 26) return amount >= 1 ? color : 0;
  if (amount < 1 / 3) return offColor(color);
  if (amount < 2 / 3) return 63 + 2 * color;
  return color;
}

/** Dark partner of a palette colour: the off version of that hue. */
export function offColor(color: number): number {
  if (color < 1 || color > 26) return LED.off;
  return 64 + 2 * color;
}

/** Pure green. Scene colors never use this index. */
const SELECTED = 126;

function scenePadLeds(project: Project, mode: "journal" | "set", tick: number, journalPage: number, copyHeld: boolean): Led[] {
  const ids = mode === "set" ? setPadIds(project) : journalPadIds(project, journalPage);
  const selected = copyHeld ? new Set(project.clipboardSceneIds) : null;
  if (ids.every((id) => id === null)) {
    return ids.map((_, index) => (index === 0 ? currentSceneLed(LED.working) : led("off", false)));
  }
  const morph = project.morph;
  const targetId = morph?.targetId ?? null;
  const activeId = project.activeSceneId;
  const progress = morph ? morphProgress(morph, tick) : 0;
  // Armed target shows at least dark so the press is visible before the morph starts.
  const targetAmount = morph ? Math.max(progress, 1 / 6) : 0;
  return ids.map((id) => {
    if (!id) return led("off", false);
    const scene = project.journal.find((item) => item.id === id);
    const color = scene?.color ?? sceneColor(id);
    if (selected?.has(id)) return { family: "yellow", color: SELECTED, blink: true, blinkTo: color };
    if (targetId && id === targetId) {
      return { family: "yellow", color: shadeColor(color, targetAmount), blink: true };
    }
    if (id === activeId) return currentSceneLed(color);
    return { family: "yellow", color, blink: false };
  });
}

/** Top two rows are pages. The next row is depth then scope. The bottom row is intensity, and a factory restore at the right. */
function randomizePadLeds(project: Project, context: ContextId, page: number): Led[] {
  const out = Array.from({ length: 32 }, () => led("off", false));
  paintRandomizePages(out, project, context, page);
  RANDOMIZE_DEPTHS.forEach((id, col) => {
    out[8 + col] = choiceLed("purple", LED.purple, project.randomizeDepth === id);
  });
  RANDOMIZE_SCOPES.forEach((id, col) => {
    out[12 + col] = choiceLed("yellow", 3, project.randomizeScope === id);
  });
  (["soft", "medium", "hard"] as const).forEach((id, index) => {
    out[index] = choiceLed("yellow", LED.yellow, project.randomizeIntensity === id);
  });
  out[7] = led("red", false);
  return out;
}

function pageOverlay(base: Led[], context: ContextId, page: number, rows: 1 | 2 = 2): Led[] {
  const out = base.slice();
  const count = pageCount(context);
  for (let col = 0; col < 8; col++) {
    out[24 + col] = col < count ? pageLed(context, col, col === page) : led("off", false);
    if (rows < 2) continue;
    const extra = 8 + col;
    out[16 + col] = extra < count ? pageLed(context, extra, extra === page) : led("off", false);
  }
  return out;
}

/** The playing scene pulses between its colour and white. */
function currentSceneLed(color: number): Led {
  return { family: "yellow", color, blink: true, blinkTo: LED.white };
}

function pageLed(context: ContextId, index: number, current: boolean): Led {
  const color = pageGroupColor(context, index);
  return { family: "yellow", color, blink: current, blinkTo: current ? offColor(color) : undefined };
}

/**
 * Pad MIDI. Channel 0 sets the colour and stops a pulse. A blink latches its
 * dim end on channel 0, then channel 9 carries the colour that stays visible.
 * The mirror keeps only the last note-on, so that visible colour has to be
 * the pulse velocity.
 *
 * The device latches a channel-0 colour only when it differs from the colour
 * the pad is already holding, and only after that message has left. A pulse
 * aimed at the colour the pad already shows never leaves it. The dim write
 * is therefore preceded by a third colour, and each step waits for the next
 * drain. Move's MIDI out holds 20 messages per audio block; a full pad
 * repaint has to be drained across blocks or the dropped colour leaves the
 * pulse on the previous page.
 */
const PAD_NOTE_ON = 0x90;
const PAD_PULSE = 0x99;

/** Dim end of a blink whose model says off. Never zero: that velocity clears the pulse. */
function pulseTrough(color: number): number {
  if (color === LED.red) return DIM_RED;
  if (color === LED.lock) return DIM_LOCK;
  const partner = offColor(color);
  if (partner !== LED.off) return partner;
  return color === NEAR_OFF ? 123 : NEAR_OFF;
}

function blinkTrough(led: Led): number {
  if (led.blinkTo) return led.blinkTo;
  return pulseTrough(led.color);
}

/** A colour that is neither the bright end nor the dim end, so the dim write changes the latch. */
function pokeColor(bright: number, trough: number): number {
  if (bright !== LED.white && trough !== LED.white) return LED.white;
  if (bright !== 3 && trough !== 3) return 3;
  return 1;
}

export function padPackets(note: number, led: Led): number[][] {
  if (!led.blink) return [[0x09, PAD_NOTE_ON, note, led.color]];
  const trough = blinkTrough(led);
  return [
    [0x09, PAD_NOTE_ON, note, pokeColor(led.color, trough)],
    [0x09, PAD_NOTE_ON, note, trough],
    [0x09, PAD_PULSE, note, led.color],
  ];
}

/** Latest unsent LED packet per status+note. A newer offer replaces the old one in place. */
export function offerLed(out: Map<number, number[]>, packet: number[]): void {
  out.set((packet[1] << 8) | packet[2], packet);
}

export function dropLed(out: Map<number, number[]>, status: number, data1: number): void {
  out.delete((status << 8) | data1);
}

/**
 * Hand the device up to `budget` LED messages. A pulse stays queued while its
 * colour is still queued or went out in this same drain.
 */
export function takeLeds(out: Map<number, number[]>, budget: number): number[][] {
  const colourWaiting = new Set<number>();
  for (const packet of out.values()) {
    if (packet[1] === PAD_NOTE_ON) colourWaiting.add(packet[2]);
  }
  const colourSent = new Set<number>();
  const send: number[][] = [];
  const keep = new Map<number, number[]>();
  for (const [key, packet] of out) {
    const holdPulse = packet[1] === PAD_PULSE && (colourWaiting.has(packet[2]) || colourSent.has(packet[2]));
    if (holdPulse || send.length >= budget) {
      keep.set(key, packet);
      continue;
    }
    send.push(packet);
    if (packet[1] === PAD_NOTE_ON) colourSent.add(packet[2]);
  }
  out.clear();
  for (const [key, packet] of keep) out.set(key, packet);
  return send;
}

/** USB-MIDI realtime. Start resets the shared pulse phase; clock advances it one 24th. */
const PULSE_START = [0x0f, 0xfa, 0x00, 0x00];
const PULSE_CLOCK = [0x0f, 0xf8, 0x00, 0x00];

export interface PulseClock {
  started: boolean;
  originMs: number;
  sent: number;
  tempo: number;
}

export const PULSE_CLOCK_IDLE: PulseClock = { started: false, originMs: 0, sent: 0, tempo: 0 };

/**
 * Keep every pad pulse on one wall-clock grid. A new pulse joins that phase,
 * so opening Mute or Capture does not restart the breath. Start is sent only
 * on a quarter boundary (and again after a tempo change); clocks are 24 per quarter.
 */
export function advancePulseClock(state: PulseClock, now: number, tempo: number): { state: PulseClock; packets: number[][] } {
  const safe = Math.max(1, tempo);
  const quarter = 60_000 / safe;
  const step = quarter / 24;
  if (!state.started || state.tempo !== safe) {
    const into = now % quarter;
    const nearStart = into <= step;
    const nearEnd = quarter - into <= step;
    if (!nearStart && !nearEnd) {
      return { state: state.started ? { ...state, started: false, tempo: safe } : state, packets: [] };
    }
    const origin = nearStart ? now - into : now - into + quarter;
    return { state: { started: true, originMs: origin, sent: 0, tempo: safe }, packets: [PULSE_START] };
  }
  const due = Math.floor((now - state.originMs) / step + 1e-6);
  let count = due - state.sent;
  if (count <= 0) return { state, packets: [] };
  if (count > 4) count = 4;
  return { state: { ...state, sent: state.sent + count }, packets: Array.from({ length: count }, () => PULSE_CLOCK) };
}

/** Half a quarter note at this tempo, in milliseconds. The blink runs on the wall clock. */
export function blinkHalfMs(tempo: number): number {
  return Math.max(1, Math.round(30_000 / Math.max(1, tempo)));
}

export function ledColorAt(led: Led, now: number, tempo: number): number {
  if (!led.blink) return led.color;
  const on = Math.floor(now / blinkHalfMs(tempo)) % 2 === 0;
  return on ? led.color : (led.blinkTo ?? LED.off);
}

function led(family: LedFamily, blink: boolean): Led {
  return { family, color: COLOR[family], blink };
}
