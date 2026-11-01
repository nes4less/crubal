// A form's role (7.7, revision 14): make, keep or act, read from the contract; absent is undefined (the
// reader of a package treats it as keep); any other word is refused, and a role on a contract that is not
// a form is refused.
import assert from "node:assert/strict";
import test from "node:test";
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
