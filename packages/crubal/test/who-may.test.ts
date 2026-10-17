// A contract's `who` may say `caller may edit Deployment` (6.3, 7.6): the caller holds that menu item on the
// record by their edges (14.6). A Controller (admin) holds everything; staff with the item through a control
// edge hold it; a member whose consume edge sits on the record does not, so a settings form is refused to
// them with `who`, even though consume lets them run forms on their own part. A hosted caller with no record
// of their own here is still what their edges make them.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Access, readAccess } from "../src/access.ts";
import { readDefinitions } from "../src/defs.ts";
import { Exchange } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";

const DEFS = `kind: deployment
  levels: deployment
kind: person
  levels: person
deploymentName$
emailSending?
name$
`;
const CONTRACTS = `contract: settings
  kind: form
  origin: declared
  for: deployment
  who: caller may edit Deployment
  needs:
    emailSending
contract: profile
  kind: form
  origin: declared
  needs:
    !name
`;
const PERMS = `permissions: platform
  menu:
    settings: edit Deployment, run settings
  presets:
    controller: settings                     audience: staff
  relations: operator, staff, customer
`;

const fresh = (edges: { who: string; mode: string; on: string; grants?: string[] }[]) => {
  const dict = readDefinitions(DEFS);
  const ex = new Exchange(dict, readContracts(CONTRACTS), [], []);
  ex.put({ id: "ROOT", kind: "deployment", level: "deployment", owner: "shop.example", values: { deploymentName: "Shop" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  ex.put({ id: "P-9", kind: "person", level: "person", owner: "shop.example", values: { name: "Sam" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  const { perms } = readAccess(PERMS);
  ex.access = new Access(
    dict,
    perms,
    ex.records as never,
    edges.map((e, i) => ({ edge: `E-${i + 1}`, relation: e.mode === "admin" ? "operator" : e.mode === "control" ? "staff" : "customer", grants: e.grants ?? [], by: "owner", line: 0, ...e })) as never,
    "shop.example",
  );
  return ex;
};

const run = (ex: Exchange, caller: string) => ex.receiveRun("settings", "ROOT", JSON.stringify({ emailSending: false }), caller);

test("a Controller holds every item: the settings form runs and lands", () => {
  const ex = fresh([{ who: "person:cashierfu.com:P-1", mode: "admin", on: "ROOT" }]);
  const r = run(ex, "person:cashierfu.com:P-1");
  assert.equal(r.stopped, undefined, JSON.stringify(r));
  assert.equal(ex.get("ROOT")?.values.emailSending, false);
});

test("staff holding the item through a control edge run it; a member with consume on the record is refused by who", () => {
  const staff = fresh([{ who: "person:cashierfu.com:P-2", mode: "control", on: "ROOT", grants: ["controller"] }]);
  assert.equal(run(staff, "person:cashierfu.com:P-2").stopped, undefined);
  const member = fresh([{ who: "person:cashierfu.com:P-3", mode: "consume", on: "ROOT" }]);
  assert.equal(run(member, "person:cashierfu.com:P-3").stopped, "who");
  assert.equal(member.get("ROOT")?.values.emailSending, undefined);
  // The same member still runs a form the package leaves open on their own part.
  const own = fresh([{ who: "P-9", mode: "consume", on: "P-9" }]);
  assert.equal(own.receiveRun("profile", "P-9", JSON.stringify({ name: "Sam Ortiz" }), "P-9").stopped, undefined);
});

test("a who over roles on the caller's record still works beside it", () => {
  const dict = readDefinitions(`kind: person\n  levels: person\nname$\nroles$*\n`);
  const ex = new Exchange(dict, readContracts(`contract: rename\n  kind: form\n  origin: declared\n  who: caller may edit name\n  needs:\n    !name\n`), [{ name: "editor", may: { edit: ["name"] }, line: 0 } as never], []);
  ex.put({ id: "P-1", kind: "person", level: "person", owner: "t", values: { name: "A", roles: ["editor"] }, sources: { "*": { origin: "declared", via: "L-1" } } });
  ex.put({ id: "P-2", kind: "person", level: "person", owner: "t", values: { name: "B" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  assert.equal(ex.receiveRun("rename", "P-1", JSON.stringify({ name: "A2" }), "P-1").stopped, undefined);
  assert.equal(ex.receiveRun("rename", "P-2", JSON.stringify({ name: "B2" }), "P-2").stopped, "who");
});
