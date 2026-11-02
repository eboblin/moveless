/** JSON state only. QuickJS on the device has no structuredClone. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** One plain tree. Lane copies use this so a morph step does not build a JSON string. */
export function copy<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => copy(item)) as T;
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(value)) out[key] = copy((value as Record<string, unknown>)[key]);
  return out as T;
}
