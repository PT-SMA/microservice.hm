export function isNonNullish<Data = unknown>(
  data: Data,
): data is NonNullable<Data> {
  return typeof data !== "undefined" && data !== null;
}

export function isEmptyObject(data: object): boolean {
  return Object.keys(data).length === 0;
}
