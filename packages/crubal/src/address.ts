// address.ts: one reader for the addresses rules and views share (1.10, 6.3, 12). An address names a place inside
// a record: a key, a level below (`unit::price`), the record's own parts (`parts[*].condition`), a step through a
// link facet into the shared parts it points at (`works[*].genres`, `work.title`), or a step into a compound's
// rows by child (`ratings[*].value`). An aggregate combines what an address reads, with an optional row filter.
import type { Dictionary, Facet } from "./defs.ts";

/** `<combine> of <address>`, with an optional `where <condition>` read against each row or lower record. */
export const AGGREGATE = /^(join|sum|best|narrow|worst|deduct|replace|keep|count|least|most) of (\S+)(?: where (.+))?$/;

export function aggregateOf(text: string): { how: string; address: string; where?: string } | null {
  const m = text.match(AGGREGATE);
  return m ? { how: m[1] as string, address: m[2] as string, ...(m[3] ? { where: m[3] } : {}) } : null;
}

/** `unit::price`: the level below and the rest. */
export function levelStep(address: string): { level: string; rest: string } | null {
  const m = address.match(/^(\w+)::(.+)$/);
  return m ? { level: m[1] as string, rest: m[2] as string } : null;
}

/** `parts[*].condition`: the key read on every owned part. */
export function partsStep(address: string): string | null {
  const m = address.match(/^parts\[\*\]\.(.+)$/);
  return m ? (m[1] as string) : null;
}

/** `works[*].genres` or `work.title`: the first step a link facet, the rest read on what it points at. */
export function linkStep(address: string, dict: Pick<Dictionary, "facets">): { link: string; rest: string } | null {
  const m = address.match(/^(\w+)(?:\[\*\])?\.(.+)$/);
  if (!m) return null;
  return dict.facets.get(m[1] as string)?.type === "link" ? { link: m[1] as string, rest: m[2] as string } : null;
}

/** `ratings[*].value`, or a bare `manifest[*]`: the compound's rows, by a child or whole. */
export function rowStep(address: string, dict: Pick<Dictionary, "facets">): { compound: string; child?: string } | null {
  const m = address.match(/^(\w+)\[\*\](?:\.(\w+))?$/);
  if (!m || m[1] === "parts") return null;
  if (dict.facets.get(m[1] as string)?.type !== "compound") return null;
  return { compound: m[1] as string, ...(m[2] ? { child: m[2] } : {}) };
}

/** The definition an address finally reads: through a level prefix, parts, a link step, and into a compound's child. */
export function facetOf(address: string, dict: Pick<Dictionary, "facets">): Facet | undefined {
  const base = address.replace(/^\w+::/, "").replace(/^parts\[\*\]\./, "");
  const m = base.match(/^(\w+)(?:\[\*\])?\.(.+)$/);
  if (!m) return dict.facets.get(base);
  const first = dict.facets.get(m[1] as string);
  if (first?.type === "link") return facetOf(m[2] as string, dict);
  if (first?.type === "compound") return first.children?.get(m[2] as string) ?? facetOf(m[2] as string, dict);
  return undefined;
}

/** The key an address finally reads, for show rules and the read set; without a dictionary, the last key named. */
export function leafOf(address: string, dict?: Pick<Dictionary, "facets">): string {
  const base = address.replace(/^\w+::/, "").replace(/^parts\[\*\]\./, "");
  const m = base.match(/^(\w+)(?:\[\*\])?\.(.+)$/);
  if (!m) return base;
  const first = dict?.facets.get(m[1] as string);
  if (!dict || first?.type === "link") return leafOf(m[2] as string, dict);
  if (first?.type === "compound") return dict.facets.has(leafOf(m[2] as string, dict)) ? leafOf(m[2] as string, dict) : (m[1] as string);
  return base;
}
