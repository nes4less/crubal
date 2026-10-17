// A contract's `audience` (7.2, 14.4): the lowest audience that may run it, member for a form unless it says
// otherwise. A member with consume on the record runs a member form and is refused a staff one, with or
// without a `who`; staff and admin run both; a bad audience is refused at publish.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Access, readAccess } from "../src/access.ts";
import { readDefinitions } from "../src/defs.ts";
import { checkContracts, Exchange } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";

const DEFS = `kind: deployment
  levels: deployment
deploymentName$
emailSending?
`;
const CONTRACTS = `contract: rename
  kind: form
  origin: declared
  needs:
    !deploymentName
contract: settings
  kind: form
  origin: declared
  audience: staff
  needs:
    emailSending
`;
const PERMS = `permissions: p
  menu:
    settings: run settings, run rename
  presets:
    controller: settings   audience: staff
  relations: operator, staff, customer
`;
const fresh = (edges: { who: string; mode: string; grants?: string[] }[]) => {
  const dict = readDefinitions(DEFS);
  const ex = new Exchange(dict, readContracts(CONTRACTS), [], []);
  ex.put({ id: "ROOT", kind: "deployment", level: "deployment", owner: "s", values: { deploymentName: "Shop" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  ex.access = new Access(dict, readAccess(PERMS).perms, ex.records as never, edges.map((e, i) => ({ edge: `E-${i}`, relation: e.mode === "admin" ? "operator" : e.mode === "control" ? "staff" : "customer", on: "ROOT", grants: e.grants ?? [], by: "owner", line: 0, ...e })) as never, "s");
  return ex;
};

test("a member runs a member form and is refused a staff form", () => {
  const ex = fresh([{ who: "M", mode: "consume" }]);
  assert.equal(ex.receiveRun("rename", "ROOT", JSON.stringify({ deploymentName: "Shop 2" }), "M").stopped, undefined);
  assert.equal(ex.receiveRun("settings", "ROOT", JSON.stringify({ emailSending: false }), "M").stopped, "permission");
  assert.equal(ex.get("ROOT")?.values.emailSending, undefined);
});

test("staff holding the item and an admin run the staff form", () => {
  const staff = fresh([{ who: "S", mode: "control", grants: ["controller"] }]);
  assert.equal(staff.receiveRun("settings", "ROOT", JSON.stringify({ emailSending: false }), "S").stopped, undefined);
  const admin = fresh([{ who: "A", mode: "admin" }]);
  assert.equal(admin.receiveRun("settings", "ROOT", JSON.stringify({ emailSending: true }), "A").stopped, undefined);
});

test("an audience that isn't one is refused at publish", () => {
  assert.throws(() => checkContracts(readContracts("contract: x\n  kind: form\n  origin: declared\n  audience: everyone\n  needs:\n    deploymentName\n"), readDefinitions(DEFS)), /audience is public, member, staff or owner/);
});
