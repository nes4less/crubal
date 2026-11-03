// A form's utility and act (spec 7.7, revision 16): a form names the utility it belongs to and, on an act
// form, the act it asks for. Carried into the bundle and back; refused at publish when the utility isn't the
// package's, the act isn't the utility's, the act sits on a form that doesn't act, or two forms name one act.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { checkPackages } from "../src/packages.ts";
import { publish } from "../src/publish.ts";
import { readContracts } from "../src/store.ts";
import { CrubalError } from "../src/tree.ts";

const shop = (tail: string) => `package: shop /2026-11-05
  owner: shop.example
  crubal: 2

kind: order
  levels: order, line
orderState{paid|picking|packed|shipped}
placedAt@
total#
buyer$

class: Order
  label: Order
  for: order
  facets:
    !orderState
    placedAt
    total
    buyer

shape: deskRow
  slots:
    !orderState -> state
    placedAt -> placed
    total -> total
    buyer -> buyer

filter: orderState
  facet: orderState

view: desk
  label: Desk
  select:
    level: order
  order: placedAt after
  page: 48
  shape: deskRow
  filters: orderState
  show: staff

contract: order
  kind: form
  role: make
  label: Order
  for: Order
  origin: declared
  audience: staff
  needs:
    !buyer
    total

permissions: shop
  menu:
    pick: run pick
  presets:
    fulfiller: pick    audience: staff
  relations: buyer, follower only

utility: orders /2026-11-05
  label: Orders
  serves: owner, fulfiller(pick)
  acts: pick, pack, ship
  mark: parcel amber

lane: ordersToPick /2026-11-05
  label: Orders to pick
  utility: orders
  view: desk
  pick: orderState = paid
  done: orderState = picking
  band: daily
  house: 7
  serves: owner, fulfiller(pick)
  home:
    figure: count
    press: Pick -> /orders
  card:
    name: buyer
    primary: Pick -> pick

lane: ordersToPack /2026-11-05
  label: Orders to pack
  utility: orders
  view: desk
  pick: orderState = picking
  done: orderState = packed
  band: daily
  house: 8
  serves: owner, fulfiller(pick)
  home:
    figure: count
    press: Pack -> /orders
  card:
    name: buyer
    primary: Pack -> pack

${tail}
`;

const judge = `contract: pickForm
  kind: form
  role: act
  utility: orders
  act: pick
  label: Pick
  for: Order
  origin: observed
  audience: staff
  needs:
    orderState

contract: buyerNote
  kind: form
  utility: orders
  label: Buyer note
  for: Order
  origin: declared
  audience: staff
  needs:
    buyer`;

test("a form names its utility and its act, read as written", () => {
  const cs = readContracts(shop(judge));
  const pick = cs.find((c) => c.name === "pickForm");
  assert.equal(pick?.parts.utility, "orders");
  assert.equal(pick?.parts.act, "pick");
  assert.equal(cs.find((c) => c.name === "buyerNote")?.parts.utility, "orders");
  assert.equal(cs.find((c) => c.name === "order")?.parts.utility, undefined);
  checkPackages(shop(judge));
});

test("a form's utility and act round-trip through the bundle", () => {
  const first = bundleOf(parsePackage(shop(judge)));
  const c = (first.contracts as { contract: string; utility?: string; act?: string }[]).find((x) => x.contract === "pickForm");
  assert.deepEqual([c?.utility, c?.act], ["orders", "pick"]);
  const text = printBundle(first);
  assert.match(text, /^  utility: orders$/m);
  assert.match(text, /^  act: pick$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  // The contract checks (7.10) admit the two parts on a form: the package publishes whole.
  const { bundle } = publish(shop(judge), { date: "2026-11-06" });
  assert.ok(bundle);
});

const refused = (tail: string, why: RegExp) =>
  assert.throws(() => checkPackages(shop(tail)), (e: unknown) => e instanceof CrubalError && why.test(e.message));

test("a form's utility and act are refused when they name what the package lacks", () => {
  refused(judge.replace("utility: orders\n  act: pick", "utility: returns\n  act: pick"), /utility returns, which this package doesn't declare/);
  refused(judge.replace("\n  act: pick", "\n  act: refund"), /act refund, which orders doesn't provide/);
  refused(judge.replace("utility: orders\n  act: pick", "act: pick"), /names no utility/);
  refused(judge.replace("  role: act\n  utility: orders\n  act: pick", "  role: keep\n  utility: orders\n  act: pick"), /only an act form names an act/);
  refused(`${judge}\n\n${judge.split("\n\n")[0]?.replace("pickForm", "pickAgain")}`, /both name the act pick of orders/);
  refused(judge.replace("utility: orders\n  label: Buyer note", "utility: Orders!\n  label: Buyer note"), /utility is a lower-case word/);
});

test("only a form names a utility or an act", () => {
  const send = `contract: notify
  kind: send
  utility: orders
  for: Order
  to: buyer`;
  refused(send, /only a form names a utility/);
});
