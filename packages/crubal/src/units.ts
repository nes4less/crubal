// units.ts: the units table (spec 1.4.3, 11.9), read from the standard package's reference records
// (crubal.com/units, embedded as units-table.ts and checked against std/units/units.crubal) plus an owner's
// extension. Spellings fold to a unit; amounts convert within a dimension by factor and offset, rounded to
// the facet's places or the dimension's rounding. A spelling nobody knows is a unit question for review,
// never a unit minted on sight.

import { readTree } from "./tree.ts";
import { STANDARD_UNITS } from "./units-table.ts";

export type Unit = { unit: string; dimension: string; factor: number; offset: number; rounding?: number; spellings: string[]; uncefact?: string; extension?: boolean };
export type Currency = { code: string; name: string; places: number };
export type UnitsTable = { units: Map<string, Unit>; currencies: Map<string, Currency>; version: string };

const foldSpelling = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** Read a units table's records (measure and currency) from the text form. */
export function readUnits(text: string, into?: UnitsTable, extension = false): UnitsTable {
  const table: UnitsTable = into ?? { units: new Map(), currencies: new Map(), version: "" };
  for (const n of readTree(text)) {
    if (n.kind !== "pair" || !n.key) continue;
    const get = (k: string) => n.children.find((c) => c.key === k)?.value.trim();
    if (n.key === "package") table.version = n.value.split(" /")[1]?.trim() ?? table.version;
    if (n.key === "measure") {
      const name = n.value.trim();
      const have = table.units.get(name);
      const spellings = (get("spellings") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      // An extension may add spellings to a standard unit; it never changes its factor or dimension (11.9).
      if (have && extension) {
        have.spellings = [...have.spellings, ...spellings.filter((s) => !have.spellings.includes(s))];
        continue;
      }
      const u: Unit = { unit: name, dimension: get("dimension") ?? "", factor: Number(get("factor") ?? 1), offset: Number(get("offset") ?? 0), spellings, ...(extension ? { extension: true } : {}) };
      const r = get("rounding");
      if (r !== undefined) u.rounding = Number(r);
      const code = get("uncefact");
      if (code) u.uncefact = code;
      table.units.set(name, u);
    }
    if (n.key === "currency") table.currencies.set(n.value.trim(), { code: n.value.trim(), name: get("name") ?? "", places: Number(get("places") ?? 2) });
  }
  return table;
}

let current: UnitsTable = readUnits(STANDARD_UNITS);

/** The table in force: the standard table at its version, plus any extension. */
export function unitsTable(): UnitsTable {
  return current;
}

/** Add an owner's units extension (11.9): its own units under its prefix, and spellings for standard ones. */
export function extendUnits(text: string): UnitsTable {
  current = readUnits(text, current, true);
  return current;
}

/** Back to the standard table alone. */
export function resetUnits(): void {
  current = readUnits(STANDARD_UNITS);
}

/** The real unit a spelling names, or null: the unit itself, or one of its spellings, folded. */
export function unitOf(spelling: string): string | null {
  if (current.units.has(spelling)) return spelling;
  const k = foldSpelling(spelling);
  for (const u of current.units.values()) if (u.unit.toLowerCase() === k || u.spellings.some((s) => foldSpelling(s) === k)) return u.unit;
  return null;
}

/** Is this a unit the table knows, `currency`, or an ISO 4217 code (1.4.4)? */
export function knownUnit(u: string): boolean {
  return u === "currency" || /^[A-Z]{3}$/.test(u) || current.units.has(u);
}

export function dimensionOf(unit: string): string | null {
  return current.units.get(unit)?.dimension ?? null;
}

/** A currency's minor-unit places (ISO 4217), for a border that asks for them; 2 when unknown. */
export function currencyPlaces(code: string): number {
  return current.currencies.get(code)?.places ?? 2;
}

/**
 * Convert an amount between units of one dimension: through the base by factor and offset, rounded to
 * `places`, else the dimension's rounding, else 6 places with trailing zeros dropped.
 */
export function convert(amount: string, from: string, to: string, places?: number): string | null {
  const a = current.units.get(from);
  const b = current.units.get(to);
  if (!a || !b || a.dimension !== b.dimension) return null;
  const base = Number(amount) * a.factor + a.offset;
  const v = (base - b.offset) / b.factor;
  // The facet's places are kept exactly; the dimension's rounding is a most, trailing zeros dropped.
  if (places !== undefined) return v.toFixed(places);
  const dimRounding = [...current.units.values()].find((u) => u.dimension === a.dimension && u.factor === 1 && u.offset === 0)?.rounding;
  return String(Number(v.toFixed(dimRounding ?? 6)));
}
