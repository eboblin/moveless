import { lanePages, type MorphKind } from "./pages.ts";
import { LANES, type LaneId, type Lanes } from "./types.ts";

export type { MorphKind };

export interface Field {
  path: string;
  kind: MorphKind;
  value: number;
}

interface Slot {
  /** Path under the lane, already split so the stamp walk does not allocate. */
  parts: readonly string[];
  full: string;
  kind: MorphKind;
}

const SLOTS: Record<LaneId, Slot[]> = {} as Record<LaneId, Slot[]>;
for (const lane of LANES) {
  const slots: Slot[] = [];
  for (const item of lanePages(lane)) {
    for (const binding of item.bindings) {
      if (!binding || binding.store !== "lane") continue;
      slots.push({
        parts: binding.path.split("."),
        full: `${lane}.${binding.path}`,
        kind: binding.morph,
      });
    }
  }
  SLOTS[lane] = slots;
}

function readSlot(root: object, parts: readonly string[]): number {
  let current: unknown = root;
  for (const part of parts) current = (current as Record<string, unknown>)[part];
  return current as number;
}

export function fieldsOf(lanes: Lanes): Field[] {
  const out: Field[] = [];
  for (const lane of LANES) {
    const root = lanes[lane];
    for (const slot of SLOTS[lane]) out.push({ path: slot.full, kind: slot.kind, value: readSlot(root, slot.parts) });
  }
  return out;
}

/** Mix field values into a stamp. No Field objects. */
export function mixFieldValues(lanes: Lanes, mix: (n: number) => void, only?: LaneId): void {
  const list = only ? [only] : LANES;
  for (const lane of list) {
    const root = lanes[lane];
    for (const slot of SLOTS[lane]) mix(readSlot(root, slot.parts));
  }
}

/** Dotted path. Missing nodes are `undefined`; callers that require a number use {@link getPath}. */
export function nodeAt(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function getPath(root: unknown, path: string): number {
  const value = nodeAt(root, path);
  if (typeof value !== "number") throw new Error(`missing ${path}`);
  return value;
}

export function setPath(root: unknown, path: string, value: number): void {
  const parts = path.split(".");
  const key = parts.pop();
  if (!key) throw new Error(`missing ${path}`);
  const parent = parts.length ? nodeAt(root, parts.join(".")) : root;
  if (parent === null || typeof parent !== "object") throw new Error(`missing ${path}`);
  (parent as Record<string, number>)[key] = value;
}

export function morphValue(kind: MorphKind, from: number, to: number, t: number): number {
  // Discrete fields stay put until the morph lands. The heard phrase blends the whole way.
  if (kind === "switch") return t >= 1 ? to : from;
  return from + (to - from) * t;
}
