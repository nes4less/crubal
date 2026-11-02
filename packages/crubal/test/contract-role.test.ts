// A form's role (7.7, revision 14): make, keep or act, read from the contract; absent is undefined (the
// reader of a package treats it as keep); any other word is refused, and a role on a contract that is not
// a form is refused.
import assert from "node:assert/strict";
import test from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { readDefinitions } from "../src/defs.ts";
import { checkContracts } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";

const pkg = (role: string, kind = "form") => `package: t /2026-01-01
  owner: t.test
  label: T
  crubal: 2

contract: thing
  kind: ${kind}
  label: Thing
  for: Thing
  ${role ? `role: ${role}` : ""}
  origin: declared
  audience: staff
  who: caller may edit Thing
  needs:
    !name
`;

test("a form's role reads: make, keep, act; absent is undefined", () => {
  assert.equal(readContracts(pkg("make"))[0]?.role, "make");
  assert.equal(readContracts(pkg("keep"))[0]?.role, "keep");
  assert.equal(readContracts(pkg("act"))[0]?.role, "act");
  assert.equal(readContracts(pkg(""))[0]?.role, undefined);
  assert.equal(readContracts(pkg("make"))[0]?.parts.role, undefined, "a role is a field, not a free part");
});

test("any other word is refused, with the line; a role on a receive contract is refused", () => {
  assert.throws(() => readContracts(pkg("delete")), /role is make, keep or act, not delete/);
  assert.throws(() => readContracts(pkg("make", "receive")), /only a form has a role/);
});

test("the role rides the bundle: in its JSON, in its printed text, and back through the reader", () => {
  const b = bundleOf(parsePackage(pkg("act")));
  const c = (b.contracts as { contract: string; role?: string }[])[0];
  assert.equal(c?.role, "act");
  assert.match(printBundle(b), /\n  role: act\n/);
  assert.equal(readBundle(b).contracts[0]?.role, "act");
  assert.equal(readContracts(printBundle(b))[0]?.role, "act");
});

test("the publish check (7.10) takes a form's role as a part of the form: an install of a package carrying roles passes", () => {
  // 0.3.45 had refused every such package at install ("a form contract has no part role"), the role's line
  // standing among the part lines while the form's allowed parts lacked it.
  const defs = readDefinitions("kind: deployment\n  levels: deployment\nname$\n");
  const text = "contract: thing\n  kind: form\n  role: make\n  origin: declared\n  audience: staff\n  needs:\n    !name\n";
  assert.doesNotThrow(() => checkContracts(readContracts(text), defs));
  assert.throws(() => checkContracts(readContracts(text.replace("role: make", "rolf: make")), defs), /has no part rolf/);
});
