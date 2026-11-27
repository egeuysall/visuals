export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** How many times smaller `after` is than `before`. Below 1 means it got worse. */
export const ratio = (before: number, after: number): number | null =>
  before > 0 && after > 0 ? before / after : null;
