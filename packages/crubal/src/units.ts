// units.ts: a starter units table, standing in for the standard units package (spec chapter 11.1,
// `crubal.com/units`) until it is published. Each unit has a dimension and a factor to the dimension's base.

type Unit = { dimension: string; factor: number; spellings: string[] };

const TABLE: { [unit: string]: Unit } = {
  s: { dimension: "time", factor: 1, spellings: ["sec", "secs", "second", "seconds"] },
  min: { dimension: "time", factor: 60, spellings: ["MIN.", "mins", "minute", "minutes"] },
  h: { dimension: "time", factor: 3600, spellings: ["hr", "hrs", "hour", "hours"] },
  mm: { dimension: "length", factor: 0.001, spellings: [] },
  cm: { dimension: "length", factor: 0.01, spellings: [] },
  m: { dimension: "length", factor: 1, spellings: [] },
  in: { dimension: "length", factor: 0.0254, spellings: ["inch", "inches", '"'] },
  ft: { dimension: "length", factor: 0.3048, spellings: ["foot", "feet"] },
  g: { dimension: "mass", factor: 0.001, spellings: [] },
  kg: { dimension: "mass", factor: 1, spellings: [] },
  oz: { dimension: "mass", factor: 0.028349523125, spellings: [] },
  lb: { dimension: "mass", factor: 0.45359237, spellings: ["lbs", "pound", "pounds"] },
};

/** The real unit a spelling names, or null. */
export function unitOf(spelling: string): string | null {
  if (TABLE[spelling]) return spelling;
  const lower = spelling.toLowerCase();
  for (const [u, def] of Object.entries(TABLE)) if (def.spellings.some((s) => s.toLowerCase() === lower)) return u;
  return null;
}

/** Convert an amount between units of one dimension, rounded to `places` (default: up to 6). */
export function convert(amount: string, from: string, to: string, places?: number): string | null {
  const a = TABLE[from];
  const b = TABLE[to];
  if (!a || !b || a.dimension !== b.dimension) return null;
  const v = (Number(amount) * a.factor) / b.factor;
  const fixed = v.toFixed(places ?? 6);
  return places === undefined ? String(Number(fixed)) : fixed;
}
