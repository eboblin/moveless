/** JSON state only. QuickJS on the device has no structuredClone. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
