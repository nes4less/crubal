// What brought a record's worn classes (5.5, revision 18): wearing with a carrier, a carrier leaving, the
// carriers written to the log as an envelope and rebuilt from it, and a carrier for a class not worn refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { shedBy, wearBy } from "../src/carriers.ts";
import { Journal, rebuild } from "../src/log.ts";
import type { Record } from "../src/model.ts";

const disc = { id: "P-1", kind: "item", level: "product", owner: "shop.example", values: { title: "Alien" }, sources: { "*": { origin: "declared", via: "L-1" } } } as unknown as Record;

test("a carrier brings classes; leaving, it takes off only those no other carrier or person holds", () => {
  let r = wearBy(disc, ["BluRay", "OpticalDisc"], { by: "gpc:10001234", version: "2026-11-03" });
  r = wearBy(r, ["OpticalDisc"], { by: "step:units" });
  r = { ...r, wears: [...(r.wears ?? []), "Collector"] }; // worn by hand: no carrier
  assert.deepEqual(r.wears, ["BluRay", "OpticalDisc", "Collector"]);
  assert.deepEqual(r.carriers?.OpticalDisc?.map((c) => c.by), ["gpc:10001234", "step:units"]);
  const shed = shedBy(r, "gpc:10001234");
  assert.deepEqual(shed.wears, ["OpticalDisc", "Collector"], "BluRay leaves; OpticalDisc stays with its other carrier; Collector was worn by hand");
  assert.deepEqual(Object.keys(shed.carriers ?? {}), ["OpticalDisc"]);
  const none = shedBy(shed, "step:units");
  assert.deepEqual(none.wears, ["Collector"]);
  assert.equal(none.carriers, undefined);
});

test("the carriers ride the log: a commit writes them as an envelope and a rebuild gives them back", () => {
  const j = new Journal("shop.example");
  j.commit({ person: "P-9" }, (d) => {
    d.records.set("P-1", wearBy(disc, ["BluRay"], { by: "gpc:10001234", version: "2026-11-03" }));
  }, "2026-11-03T10:00:00Z");
  const e2 = j.commit({ person: "P-9" }, (d) => {
    const r = d.records.get("P-1") as Record;
    d.records.set("P-1", wearBy(r, ["Collector"], { by: "K-3" }));
  }, "2026-11-03T10:01:00Z");
  assert.ok(JSON.stringify(e2).includes('"envelope":"carriers"'), "a carriers envelope write");
  const back = rebuild(j.entries).records.get("P-1");
  assert.deepEqual(back?.carriers, {
    BluRay: [{ by: "gpc:10001234", version: "2026-11-03" }],
    Collector: [{ by: "K-3" }],
  });
});
