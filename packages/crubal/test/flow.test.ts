// The `flow:` block (spec 12.11): an objective's line of stops over the package's lanes and forms. Read
// with its parts, carried into the bundle and back, versioned in `members`, and refused at publish when a
// stop names neither a lane nor a form of the package, an act its utility lacks, or a done that is no filter.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { checkPackages, readPackages } from "../src/packages.ts";
import { publish } from "../src/publish.ts";
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

const flow = `flow: pickPackShip /2026-11-05
  label: Pick, pack, ship
  utility: orders
  follow: queue
  serves: owner, fulfiller(pick)
  stops:
    order of order
    ordersToPick -> pick
    ordersToPack -> pack
  done: orderState = shipped`;

test("a flow block is read with its parts: a block stop, two lane stops with their acts, the done pick", () => {
  const [info] = readPackages(shop(flow));
  const f = info?.flows[0];
  assert.equal(f?.name, "pickPackShip");
  assert.equal(f?.version, "2026-11-05");
  assert.equal(f?.label, "Pick, pack, ship");
  assert.equal(f?.utility, "orders");
  assert.equal(f?.follow, "queue");
  assert.deepEqual(f?.serves.map((x) => [x.as, x.items]), [["owner", undefined], ["fulfiller", ["pick"]]]);
  assert.deepEqual(f?.stops.map((s) => [s.name, s.act, s.of]), [["order", undefined, "order"], ["ordersToPick", "pick", undefined], ["ordersToPack", "pack", undefined]]);
  assert.deepEqual([f?.done?.filter, f?.done?.value], ["orderState", "shipped"]);
  checkPackages(shop(flow));
});

test("a flow round-trips through its bundle and is versioned in members", () => {
  const first = bundleOf(parsePackage(shop(flow)));
  const flows = first.flows as { flow: string; stops: { name: string; act?: string; of?: string }[]; done: { filter: string; value: string } }[];
  assert.equal(flows[0]?.flow, "pickPackShip");
  assert.deepEqual(flows[0]?.stops, [{ name: "order", of: "order" }, { name: "ordersToPick", act: "pick" }, { name: "ordersToPack", act: "pack" }]);
  assert.deepEqual(flows[0]?.done, { filter: "orderState", value: "shipped" });
  const text = printBundle(first);
  assert.match(text, /^flow: pickPackShip \/2026-11-05$/m);
  assert.match(text, /^    ordersToPick -> pick$/m);
  assert.match(text, /^    order of order$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  const { bundle } = publish(shop(flow), { date: "2026-11-06" });
  assert.equal((bundle.members as { [k: string]: string })["flow:pickPackShip"], "2026-11-06");
});

const refused = (tail: string, why: RegExp) => assert.throws(() => checkPackages(shop(tail)), (e: unknown) => e instanceof CrubalError && why.test(e.message));

test("a flow is refused when a stop is neither a lane nor a form, an act is not its utility's, follow is odd, or done is no filter", () => {
  refused(flow.replace("ordersToPack -> pack", "ordersToShip -> ship"), /ordersToShip isn't a lane of this package/);
  refused(flow.replace("ordersToPack -> pack", "ordersToPack -> refund"), /refund isn't an act of orders/);
  refused(flow.replace("order of order", "invoice of order"), /invoice isn't a form of this package/);
  refused(flow.replace("order of order", "order of parcel"), /parcel isn't a level or kind/);
  refused(flow.replace("done: orderState = shipped", "done: orderState = lost"), /lost is not a value/);
  refused(flow.replace("done: orderState = shipped", "done: region = us"), /region, which isn't a filter/);
  refused(flow.replace("utility: orders", "utility: returns"), /utility returns, which this package doesn't declare/);
  assert.throws(() => readPackages(shop(flow.replace("follow: queue", "follow: sideways"))), /follow is queue or card/);
  assert.throws(() => readPackages(shop(flow.replace(/  stops:\n(?:    .*\n)+/, "  stops:\n"))), /has no stops/);
});
