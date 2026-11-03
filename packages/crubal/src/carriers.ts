// carriers.ts: what brought a record's worn classes (5.5, revision 18). Wearing a class with its carrier, and
// a carrier leaving: it takes off the classes only it brought; a class another carrier also brought, or one
// worn by hand (no carrier), stays. Pure: a record in, the record out.
import type { Carrier, Record } from "./model.ts";

/** Wear classes because a carrier brought them, noting the carrier beside each. */
export function wearBy(r: Record, classes: string[], carrier: Carrier): Record {
  const wears = [...(r.wears ?? [])];
  const carriers: { [cls: string]: Carrier[] } = { ...(r.carriers ?? {}) };
  for (const cls of classes) {
    if (!wears.includes(cls)) wears.push(cls);
    const had = (carriers[cls] ?? []).filter((c) => c.by !== carrier.by);
    carriers[cls] = [...had, carrier];
  }
  return { ...r, wears, carriers };
}

/** A carrier leaves: the classes only it brought come off; the rest keep their other carriers. */
export function shedBy(r: Record, by: string): Record {
  const carriers: { [cls: string]: Carrier[] } = {};
  const off = new Set<string>();
  for (const [cls, list] of Object.entries(r.carriers ?? {})) {
    const left = list.filter((c) => c.by !== by);
    if (left.length) carriers[cls] = left;
    else if (list.length) off.add(cls);
  }
  const out: Record = { ...r, wears: (r.wears ?? []).filter((w) => !off.has(w)) };
  if (Object.keys(carriers).length) out.carriers = carriers;
  else delete out.carriers;
  return out;
}

/** Why a record wears each class: its carriers, or by hand. */
export const carriedBy = (r: Record, cls: string): Carrier[] => r.carriers?.[cls] ?? [];
