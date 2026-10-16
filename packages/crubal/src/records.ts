// records.ts: the set of records an operation works over, behind one interface (docs/design/store.md).
// The engine reads records by ID and asks a few questions that a database answers with an index and a
// memory store answers by a scan: the records at a level, the children of a record along `of` or
// `within`, the records a contract or view targets, and the records holding a value for a key. Nothing in
// the engine scans a map directly, so a backend that loads only what an operation needs can stand in for
// the memory set without the engine knowing.

import type { Json, Record } from "./model.ts";
import { serialize } from "./canonical.ts";

export interface RecordSet extends Map<string, Record> {
  /** Every record (an integrity check or a view over everything; a backend may answer in pages). */
  all(): Record[];
  /** The records at a level (1.2). */
  atLevel(level: string): Record[];
  /** The records whose `of` or `within` names the record, at a level when one is given. */
  childrenOf(id: string, along: "of" | "within", level?: string): Record[];
  /** The records a `for` names: wearers of a class, records at a level, or records of a kind (6.1, 7.2). */
  forTarget(name: string): Record[];
  /** The records at a level whose value for a key equals the value (6.6, 9.2a). */
  byKey(key: string, value: Json, level?: string): Record[];
}

/**
 * The memory set: a map, with every question answered from it. Children and levels are indexed on first
 * use and dropped on any change, so a projection over a catalog never scans the whole map per record.
 */
export class MemoryRecords extends Map<string, Record> implements RecordSet {
  private byOf?: Map<string, Record[]>;
  private byWithin?: Map<string, Record[]>;
  private byLevel?: Map<string, Record[]>;

  override set(id: string, r: Record): this {
    this.byOf = this.byWithin = this.byLevel = undefined;
    return super.set(id, r);
  }

  override delete(id: string): boolean {
    this.byOf = this.byWithin = this.byLevel = undefined;
    return super.delete(id);
  }

  override clear(): void {
    this.byOf = this.byWithin = this.byLevel = undefined;
    super.clear();
  }

  private index(by: "of" | "within" | "level"): Map<string, Record[]> {
    const have = by === "of" ? this.byOf : by === "within" ? this.byWithin : this.byLevel;
    if (have) return have;
    const m = new Map<string, Record[]>();
    for (const r of this.values()) {
      const k = r[by];
      if (k === undefined) continue;
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    }
    if (by === "of") this.byOf = m;
    else if (by === "within") this.byWithin = m;
    else this.byLevel = m;
    return m;
  }

  all(): Record[] {
    return [...this.values()];
  }

  atLevel(level: string): Record[] {
    return [...(this.index("level").get(level) ?? [])];
  }

  childrenOf(id: string, along: "of" | "within", level?: string): Record[] {
    const list = this.index(along).get(id) ?? [];
    return level === undefined ? [...list] : list.filter((r) => r.level === level);
  }

  forTarget(name: string): Record[] {
    return this.all().filter((r) => (r.wears ?? []).includes(name) || r.level === name || r.kind === name);
  }

  byKey(key: string, value: Json, level?: string): Record[] {
    const want = serialize(value);
    return this.all().filter((r) => (level === undefined || r.level === level) && r.values[key] !== undefined && serialize(r.values[key] as Json) === want);
  }
}
