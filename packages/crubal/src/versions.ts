// versions.ts: the order of a member's or a package's versions (11.4, 11.5): a date, `YYYY-MM-DD`, then a
// second cut that day as `.2`, `.3`… The date compares as text; the suffix as a number, none counting as 1, so
// `.10` follows `.9` (plain text put it before, 2026-11-03).

/** Negative when `a` is the earlier version, positive when it is the later, 0 when they are the same. */
export function compareVersions(a: string, b: string): number {
  const [ad = "", as = "1"] = String(a).split(".");
  const [bd = "", bs = "1"] = String(b).split(".");
  if (ad !== bd) return ad < bd ? -1 : 1;
  return Number(as) - Number(bs);
}

/** The latest of some versions, or undefined for none. */
export const latestVersion = (vs: string[]): string | undefined =>
  [...vs].sort(compareVersions).at(-1);

/**
 * The version a new cut takes: the date it is cut on, a suffix after a cut the same day; never earlier than
 * the version it follows, whose date it carries on with the next suffix when the calendar is behind it (the
 * versions written ahead of the calendar, 2026-11-03).
 */
export function nextVersion(date: string, previous?: string): string {
  if (!previous) return date;
  const [pd = "", ps = "1"] = String(previous).split(".");
  if (pd < date) return date;
  return `${pd}.${Number(ps) + 1}`;
}
