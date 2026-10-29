// A contract's quorum (7.6): `quorum: <facet>` names a yes/no facet on the root. While the flag is true, a run
// of the contract is refused with `quorum` unless it cites a met proposal: a record whose `proposalContract`
// names the contract, whose `proposalState` is `met`, and, where both name a record, the same record. With
// the flag off, nothing changes. At publish, the facet named must be a yes/no one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { checkContracts, Exchange } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";

const DEFS = `kind: deployment
  levels: deployment
kind: proposal
  levels: proposal
deploymentName$
consensusOn?
emailSending?
applicationFeeBps#
proposalContract$
proposalState{open|met|applied|declined|lapsed}
proposalRecord&deployment
`;
const CONTRACTS = `contract: settings
  kind: form
  origin: declared
  for: deployment
  quorum: consensusOn
  needs:
    emailSending
contract: fees
  kind: form
  origin: declared
  for: deployment
  quorum: consensusOn
  needs:
    applicationFeeBps
`;

const fresh = (flag: boolean) => {
  const dict = readDefinitions(DEFS);
  const ex = new Exchange(dict, readContracts(CONTRACTS), [], []);
  ex.put({
    id: "ROOT",
    kind: "deployment",
    level: "deployment",
    owner: "shop.example",
    values: { deploymentName: "Shop", ...(flag ? { consensusOn: true } : {}) },
    sources: { "*": { origin: "declared", via: "L-1" } },
  });
  return ex;
};
const proposal = (ex: Exchange, id: string, values: { [k: string]: unknown }) =>
  ex.put({
    id,
    kind: "proposal",
    level: "proposal",
    owner: "shop.example",
    values: values as never,
    sources: { "*": { origin: "declared", via: "L-1" } },
  });
const run = (ex: Exchange) => ex.receiveRun("settings", "ROOT", JSON.stringify({ emailSending: false }));

test("with the flag off the form runs as before; on, it is refused with quorum", () => {
  const off = fresh(false);
  assert.equal(run(off).stopped, undefined);
  assert.equal(off.get("ROOT")?.values.emailSending, false);
  const on = fresh(true);
  assert.equal(run(on).stopped, "quorum");
  assert.equal(on.get("ROOT")?.values.emailSending, undefined, "nothing landed");
});

test("a met proposal cited for the contract and the record lets the run through; the wrong one does not", () => {
  const ex = fresh(true);
  proposal(ex, "PP-1", { proposalContract: "settings", proposalState: "met", proposalRecord: { $link: "ROOT" } });
  proposal(ex, "PP-2", { proposalContract: "settings", proposalState: "open", proposalRecord: { $link: "ROOT" } });
  proposal(ex, "PP-3", { proposalContract: "fees", proposalState: "met", proposalRecord: { $link: "ROOT" } });
  proposal(ex, "PP-4", { proposalContract: "settings", proposalState: "met", proposalRecord: { $link: "OTHER" } });
  ex.citing = "PP-2";
  assert.equal(run(ex).stopped, "quorum", "open, not met");
  ex.citing = "PP-3";
  assert.equal(run(ex).stopped, "quorum", "another contract's proposal");
  ex.citing = "PP-4";
  assert.equal(run(ex).stopped, "quorum", "another record's proposal");
  ex.citing = "PP-9";
  assert.equal(run(ex).stopped, "quorum", "no such proposal");
  ex.citing = "PP-1";
  const r = run(ex);
  assert.equal(r.stopped, undefined, JSON.stringify(r));
  assert.equal(ex.get("ROOT")?.values.emailSending, false);
});

test("at publish, quorum must name a yes/no facet", () => {
  const dict = readDefinitions(DEFS);
  assert.doesNotThrow(() => checkContracts(readContracts(CONTRACTS), dict));
  assert.throws(
    () => checkContracts(readContracts(CONTRACTS.replace("quorum: consensusOn", "quorum: deploymentName")), dict),
    /quorum names deploymentName, which isn't a yes\/no facet/,
  );
  assert.throws(
    () => checkContracts(readContracts(CONTRACTS.replace("quorum: consensusOn", "quorum: nothing")), dict),
    /isn't a yes\/no facet/,
  );
});
