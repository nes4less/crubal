// The surface and the lines over it (14.14, revision 43). A utility holds its chains and lanes, a chain its
// links, a link its cases' presses; each has an address. A line says see or run of an address, with `no` to
// withhold. The deepest line on the way decides, a no beats a yes at the same depth, running needs seeing, and
// nothing said is no answer. An edge holds a person's own lines and the profile it follows; a preset holds a
// profile's lines; a person's own lines are read before their presets'.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Access, checkPermissions, readAccess } from "../src/access.ts";
import { permissionsJson } from "../src/bundle.ts";
import { readDefinitions } from "../src/defs.ts";
import type { Flow, Lane, Utility } from "../src/packages.ts";
import { addressPath, readHold, surfaceAnswer, surfaceOf } from "../src/surface.ts";

const lines = (...ls: string[]) => ls.map((l) => readHold(l));

test("a line reads see or run, an address, and no before it", () => {
  assert.deepEqual(readHold("see inventory"), { verb: "see", address: "inventory" });
  assert.deepEqual(readHold("no run inventory/audit/containersAuditing"), { no: true, verb: "run", address: "inventory/audit/containersAuditing" });
  assert.deepEqual(readHold("see /shelf"), { verb: "see", address: "/shelf" });
  assert.throws(() => readHold("edit inventory"), /see or run/);
  assert.throws(() => readHold("see inventory audit"), /one address/);
  assert.throws(() => readHold("see inventory//audit"), /one address/);
  assert.deepEqual(addressPath("a/b/c"), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(addressPath("/shelf/buy"), ["/shelf", "/shelf/buy"]);
});

test("the deepest line decides, and a no beats a yes at the same depth", () => {
  const held = lines("see inventory", "run inventory", "no run inventory/audit/containersAuditing");
  assert.equal(surfaceAnswer(held, "run", "inventory/audit/unitsExpected"), "yes");
  assert.equal(surfaceAnswer(held, "run", "inventory/audit/containersAuditing"), "no");
  assert.equal(surfaceAnswer(held, "see", "inventory/audit/containersAuditing"), "yes");
  // A yes beneath a no stands against it: the chain withheld, one link handed back.
  const back = lines("see inventory", "no run inventory/audit", "run inventory/audit/unitsExpected");
  assert.equal(surfaceAnswer(back, "run", "inventory/audit/unitsExpected"), "yes");
  assert.equal(surfaceAnswer(back, "run", "inventory/audit/containersToAudit"), "no");
  assert.equal(surfaceAnswer(lines("run inventory", "no run inventory"), "run", "inventory/transfer"), "no");
  // Nothing said is no answer, and a name that only starts alike is another address.
  assert.equal(surfaceAnswer(held, "run", "orders/ship"), undefined);
  assert.equal(surfaceAnswer(lines("run inv"), "run", "inventory"), undefined);
});

test("running needs seeing, and a case's press takes its link's answer until it has its own", () => {
  const blind = lines("no see inventory/audit", "run inventory");
  assert.equal(surfaceAnswer(blind, "run", "inventory/audit/unitsExpected"), "no");
  assert.equal(surfaceAnswer(blind, "run", "inventory/transfer/transfer"), "yes");
  const judged = lines("see inventory", "run inventory", "no run inventory/audit/unitsExpected/stranger/or1");
  assert.equal(surfaceAnswer(judged, "run", "inventory/audit/unitsExpected/stranger/yes"), "yes");
  assert.equal(surfaceAnswer(judged, "run", "inventory/audit/unitsExpected/stranger/or1"), "no");
});

test("the surface is read from the utilities, chains, links, cases and lanes in force", () => {
  const serves = [{ as: "stockkeeper", line: 1 }];
  const press = (word: string, act: string) => ({ word, runs: [{ act }] });
  const utilities = [{ name: "inventory", label: "Inventory", serves }] as unknown as Utility[];
  const flows = [
    {
      name: "audit",
      label: "Audit",
      utility: "inventory",
      serves,
      stops: [
        { name: "containersToAudit", act: "startAudit", line: 1 },
        { name: "unitsExpected", act: "seen", line: 2, cases: [{ kind: "stranger", answer: "ask", yes: press("Re-file here", "refile"), no: press("Put back", "putBack"), or: [press("Quarantine", "quarantine")], line: 3 }] },
      ],
    },
  ] as unknown as Flow[];
  const lanes = [
    { name: "unitsExpected", label: "Units expected", utility: "inventory", serves, card: { primary: { word: "Seen", to: "seen", line: 1 }, quick: [{ word: "Not found", to: "notFound", line: 1 }] } },
    { name: "boxes", label: "Boxes", utility: "inventory", serves, card: { primary: { word: "Transfer", to: "transfer", line: 1 }, quiet: { word: "Open", to: "page", line: 1 }, quick: [] } },
    { name: "shelf", serves: [{ as: "public", line: 1 }] },
  ] as unknown as Lane[];
  const nodes = surfaceOf({ utilities, flows, lanes });
  assert.deepEqual(
    nodes.map((n) => `${n.sort} ${n.address}`),
    [
      "utility inventory",
      "chain inventory/audit",
      "link inventory/audit/containersToAudit",
      "link inventory/audit/unitsExpected",
      "press inventory/audit/unitsExpected/notFound",
      "case inventory/audit/unitsExpected/stranger/yes",
      "case inventory/audit/unitsExpected/stranger/no",
      "case inventory/audit/unitsExpected/stranger/or1",
      "lane inventory/boxes",
      "press inventory/boxes/transfer",
      "lane /shelf",
    ],
  );
  const link = nodes.find((n) => n.address === "inventory/audit/unitsExpected");
  assert.deepEqual([link?.label, link?.acts, link?.serves], ["Units expected", ["seen"], undefined]);
  assert.deepEqual(nodes.find((n) => n.address.endsWith("/or1"))?.acts, ["quarantine"]);
  // Every address the reader makes is one a line may name.
  for (const n of nodes) assert.equal(readHold(`see ${n.address}`).address, n.address);
});

const PERMS = `permissions: place
  menu:
    inventory: edit unit
    bench: edit unit
    people: grant inventory, bench, surface
    inviteBenchers: grant bench
  presets:
    stockkeeper: inventory               audience: staff
    bencher: bench                       audience: staff holds: see inventory/audit, run inventory/audit, no run inventory/audit/containersAuditing
    controller: inventory, bench, people audience: staff
    benchManager: bench, inviteBenchers  audience: staff
  relations: operator, staff, customer, follower only
`;

type E = { who: string; mode: string; grants?: string[]; holds?: string[]; follows?: string; by?: string; relation?: string };
const access = (edges: E[]) => {
  const dict = readDefinitions("kind: unit\n  levels: unit\n");
  const { perms } = readAccess(PERMS);
  const root = { id: "ROOT", kind: "unit", level: "unit", owner: "shop.example", values: {}, sources: {} };
  const records = { get: (id: string) => (id === "ROOT" ? root : undefined), all: () => [root] };
  const made = edges.map((e, i) => ({ edge: `E-${i + 1}`, relation: e.mode === "admin" ? "operator" : e.mode === "control" ? "staff" : "customer", on: "ROOT", grants: e.grants ?? [], by: "owner", line: 0, ...e }));
  return new Access(dict, perms, records as never, made as never, "shop.example");
};

test("a preset holds a profile's lines, read and carried", () => {
  const { perms } = readAccess(PERMS);
  assert.deepEqual(perms.presets.get("bencher")?.holds, ["see inventory/audit", "run inventory/audit", "no run inventory/audit/containersAuditing"]);
  assert.equal(perms.presets.get("bencher")?.audience, "staff");
  assert.equal(perms.presets.get("stockkeeper")?.holds, undefined);
  checkPermissions(perms, readDefinitions("kind: unit\n  levels: unit\n"));
  const json = permissionsJson(perms) as { presets: { [k: string]: { holds?: string[] } } };
  assert.deepEqual(json.presets.bencher?.holds, perms.presets.get("bencher")?.holds);
  assert.throws(() => readAccess(PERMS.replace("see inventory/audit,", "edit inventory/audit,")), /see or run/);
});

test("an edge's own lines are read before its presets', and an admin holds everything", () => {
  const a = access([
    { who: "kim", mode: "control", grants: ["bencher"] },
    { who: "lee", mode: "control", grants: ["bencher"], holds: ["run inventory/audit/containersAuditing"] },
    { who: "pat", mode: "control", grants: ["bench"], follows: "bencher", holds: ["see inventory/audit", "run inventory/audit"] },
    { who: "ada", mode: "admin" },
    { who: "fan", mode: "none", relation: "follower" },
  ]);
  // Kim follows the profile as it stands: the audit, without its finish.
  assert.equal(a.surface("kim", "run", "inventory/audit/unitsExpected"), "yes");
  assert.equal(a.surface("kim", "run", "inventory/audit/containersAuditing"), "no");
  assert.equal(a.surface("kim", "run", "inventory/transfer"), undefined);
  // Lee was handed the finish: their own line stands against the profile's.
  assert.equal(a.surface("lee", "run", "inventory/audit/containersAuditing"), "yes");
  assert.equal(a.surface("lee", "run", "inventory/audit/unitsExpected"), "yes");
  // Pat holds a copy made when the profile had no withholding; the profile's later change does not reach them.
  assert.equal(a.surface("pat", "run", "inventory/audit/containersAuditing"), "yes");
  assert.equal(a.surface("ada", "run", "anything/at/all"), "yes");
  assert.equal(a.surface("shop.example", "see", "inventory"), "yes");
  assert.equal(a.surface("fan", "see", "inventory"), undefined);
  assert.equal(a.surface("nobody", "see", "inventory"), undefined);
});

test("a store refuses lines it may not keep", () => {
  const a = access([
    { who: "boss", mode: "control", grants: ["controller"] },
    { who: "mgr", mode: "control", grants: ["benchManager"] },
  ]);
  const edge = (e: Partial<E> & { by: string }) => ({ edge: "E-9", who: "new", relation: "staff", mode: "control", on: "ROOT", grants: ["bench"], line: 0, ...e }) as never;
  // A Controller by preset carries `grant surface`; a manager who may only invite benchers does not.
  a.checkEdge(edge({ by: "E-1", holds: ["see inventory", "no run inventory/audit"], follows: "bencher" }));
  a.checkEdge(edge({ by: "E-2" }));
  assert.throws(() => a.checkEdge(edge({ by: "E-2", holds: ["no run inventory/audit"] })), /may not grant the surface/);
  a.checkEdge(edge({ by: "owner", holds: ["run inventory"] }));
  assert.throws(() => a.checkEdge(edge({ by: "owner", holds: ["press inventory"] })), /see or run/);
  assert.throws(() => a.checkEdge(edge({ by: "owner", follows: "nobody" })), /isn't a preset/);
  assert.throws(() => a.checkEdge({ edge: "E-9", who: "fan", relation: "follower", mode: "none", on: "ROOT", grants: [], holds: ["see inventory"], by: "owner", line: 0 } as never), /a relation holds nothing/);
});

test("an edge's lines and its profile are read from text", () => {
  const { edges } = readAccess(`edge: E-7
  who: person:P-1
  relation: staff
  mode: control
  on: ROOT
  grants: bench
  follows: bencher
  holds: see inventory/audit, no run inventory/audit/containersAuditing
  by: owner
`);
  assert.equal(edges[0]?.follows, "bencher");
  assert.deepEqual(edges[0]?.holds, ["see inventory/audit", "no run inventory/audit/containersAuditing"]);
});
