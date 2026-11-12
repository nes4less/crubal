// The `flow:` block (spec 12.11): an objective's line of stops over the package's lanes and forms. Read
// with its parts, carried into the bundle and back, versioned in `members`, and refused at publish when a
// stop names neither a lane nor a form of the package, an act its utility lacks, or a done that is no filter.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, emptyParsed, parsePackage, printBundle, readBundle, readBundleOnto } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { checkPermissions, readAccess } from "../src/access.ts";
import { emptyDictionary } from "../src/defs.ts";
import { checkFlowsInForce, checkPackages, flowStamps, readPackages } from "../src/packages.ts";
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
  done: orderState = packed`;

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
  assert.deepEqual([f?.done?.filter, f?.done?.value], ["orderState", "packed"]);
  checkPackages(shop(flow));
});

test("a flow round-trips through its bundle and is versioned in members", () => {
  const first = bundleOf(parsePackage(shop(flow)));
  const flows = first.flows as { flow: string; stops: { name: string; act?: string; of?: string }[]; done: { filter: string; value: string } }[];
  assert.equal(flows[0]?.flow, "pickPackShip");
  assert.deepEqual(flows[0]?.stops, [{ name: "order", of: "order" }, { name: "ordersToPick", act: "pick" }, { name: "ordersToPack", act: "pack" }]);
  assert.deepEqual(flows[0]?.done, { filter: "orderState", value: "packed" });
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
  refused(flow.replace("done: orderState = packed", "done: orderState = lost"), /lost is not a value/);
  refused(flow.replace("done: orderState = packed", "done: region = us"), /region, which isn't a filter/);
  refused(flow.replace("utility: orders", "utility: returns"), /utility returns, which this package doesn't declare/);
  assert.throws(() => readPackages(shop(flow.replace("follow: queue", "follow: sideways"))), /follow is queue or card/);
  assert.throws(() => readPackages(shop(flow.replace(/  stops:\n(?:    .*\n)+/, "  stops:\n"))), /has no stops/);
});

// Revision 22: the stamps and the chain.
test("a flow's stamps are derived from its lanes: a lane stop its done, a block stop the next lane's pick", () => {
  const [info] = readPackages(shop(flow));
  const f = info?.flows[0];
  assert.ok(f && info);
  const stamps = flowStamps(f, info.lanes, (flt) => (flt === "orderState" ? "orderState" : undefined));
  assert.deepEqual(stamps, [
    { stop: "order", at: 0, facet: "orderState", value: "paid" },
    { stop: "ordersToPick", at: 1, facet: "orderState", value: "picking" },
    { stop: "ordersToPack", at: 2, facet: "orderState", value: "packed" },
  ]);
  // A filter the views don't know stamps nothing; a block after the last lane stamps nothing.
  assert.deepEqual(flowStamps(f, info.lanes, () => undefined), []);
  const tail = readPackages(shop(flow.replace("    order of order\n", "").replace("    ordersToPack -> pack", "    ordersToPack -> pack\n    order of order")));
  const g = tail[0]?.flows[0];
  assert.ok(g && tail[0]);
  assert.deepEqual(flowStamps(g, tail[0].lanes, () => "orderState").map((x) => x.stop), ["ordersToPick", "ordersToPack"]);
});

test("a flow is refused when its lane stops do not chain, or its done is not its last lane's, or a stop is a list", () => {
  refused(flow.replace("    ordersToPick -> pick\n    ordersToPack -> pack", "    ordersToPack -> pack\n    ordersToPick -> pick"), /gap: ordersToPack is done at orderState = packed, but ordersToPick picks orderState = paid/);
  refused(flow.replace("done: orderState = packed", "done: orderState = shipped"), /done is orderState = shipped, but its last lane ordersToPack leaves a record at orderState = packed/);
  const list = `lane: ordersAll /2026-11-05
  label: Every order
  utility: orders
  view: desk
  band: daily
  house: 9
  serves: owner
  home:
    figure: count
    press: Look -> /orders

`;
  refused(`${list}${flow.replace("ordersToPack -> pack", "ordersAll")}`, /ordersAll is a list: it holds no state, so it is a stop only with an act \(ordersAll -> <act>\)/);
  // Revision 37: a list is a stop where the stop names its act. It chains with nothing (the state stops chain
  // across it, the flow's done is its last state lane's) and stamps nothing.
  const between = flow.replace("    ordersToPack -> pack", "    ordersAll -> pack\n    ordersToPack -> pack");
  checkPackages(shop(`${list}${between}`));
  const withList = readPackages(shop(`${list}${between}`));
  const fl = withList[0]?.flows[0];
  assert.ok(fl && withList[0]);
  assert.deepEqual(flowStamps(fl, withList[0].lanes, () => "orderState").map((x) => x.stop), ["order", "ordersToPick", "ordersToPack"]);
  // The state stops still chain across a list stop.
  refused(`${list}${flow.replace("    ordersToPick -> pick\n    ordersToPack -> pack", "    ordersToPack -> pack\n    ordersAll -> pack\n    ordersToPick -> pick")}`, /gap: ordersToPack is done at orderState = packed, but ordersToPick picks orderState = paid/);
  // A block between two lanes leaves the chain as it is; a block after the last lane is fine.
  checkPackages(shop(flow.replace("    ordersToPack -> pack", "    order of order\n    ordersToPack -> pack")));
  checkPackages(shop(flow.replace("    ordersToPack -> pack", "    ordersToPack -> pack\n    order of order")));
});

// Revision 23: what a flow holds through its run, and the flow it stands in for.
test("a flow's context and replaces are read, carried, printed back, and checked", () => {
  const withContext = flow.replace("  follow: queue\n", "  follow: queue\n  context: order\n  replaces: pickPackShipOld\n");
  const [info] = readPackages(shop(withContext));
  const f = info?.flows[0];
  assert.deepEqual(f?.context, ["order"]);
  assert.equal(f?.replaces, "pickPackShipOld");
  checkPackages(shop(withContext));
  const b = bundleOf(parsePackage(shop(withContext)));
  const j = (b.flows as { context?: unknown; replaces?: unknown }[])[0];
  assert.deepEqual(j?.context, ["order"]);
  assert.equal(j?.replaces, "pickPackShipOld");
  const text = printBundle(b);
  assert.match(text, /^  context: order$/m);
  assert.match(text, /^  replaces: pickPackShipOld$/m);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
  // A flow with neither prints neither.
  assert.doesNotMatch(printBundle(bundleOf(parsePackage(shop(flow)))), /context:|replaces:/);
  refused(flow.replace("  follow: queue\n", "  follow: queue\n  context: parcel\n"), /context names parcel, which isn't a kind or level/);
  refused(flow.replace("  follow: queue\n", "  follow: queue\n  replaces: pickPackShip\n"), /replaces itself/);
  assert.throws(() => readPackages(shop(flow.replace("  follow: queue\n", "  follow: queue\n  replaces: Two Words\n"))), /replaces names a flow/);
});

test("edit flows is a menu item's target (revision 23): the designer's gate", () => {
  const { perms } = readAccess("permissions: shop\n  menu:\n    design: edit flows\n  presets:\n    designer: design    audience: staff\n");
  checkPermissions(perms, emptyDictionary());
  assert.deepEqual(perms.menu.get("design")?.verbs, { edit: ["flows"] });
});

// Revision 23: a package that extends another walks its lanes and forms; the check in force sees the whole.
const own = (stops: string, done = "orderState = packed") => `package: own /2026-11-06
  owner: shop.example
  crubal: 2
  extends: shop.example/shop /2026-11-05

flow: myPickPack /2026-11-06
  label: My pick and pack
  utility: orders
  follow: queue
  serves: owner, fulfiller(pick)
  replaces: pickPackShip
  stops:
${stops}
  done: ${done}
`;

test("a flow in an extending package may name the lanes, forms, utility and presets it extends; the check in force refuses a gap", () => {
  const good = own("    order of order\n    ordersToPick -> pick\n    ordersToPack -> pack");
  // File-local: the extending package alone checks (what it cannot see is deferred).
  checkPackages(good);
  const inForce = (ownText: string) => {
    const base = emptyParsed();
    readBundleOnto(bundleOf(parsePackage(shop(flow))), base);
    readBundleOnto(bundleOf(parsePackage(ownText)), base);
    return base;
  };
  checkFlowsInForce(inForce(good));
  assert.equal(inForce(good).info.flows.map((f) => f.name).join(","), "pickPackShip,myPickPack");
  // A lane nobody declares, a gap, a utility not in force: refused in force, as a publish would have.
  assert.throws(() => checkFlowsInForce(inForce(own("    ordersToPick -> pick\n    ordersToShip -> ship"))), /ordersToShip isn't a lane in force here/);
  assert.throws(() => checkFlowsInForce(inForce(own("    ordersToPack -> pack\n    ordersToPick -> pick"))), /has a gap: ordersToPack is done at orderState = packed, but ordersToPick picks orderState = paid/);
  assert.throws(() => checkFlowsInForce(inForce(own("    ordersToPick -> pick", "orderState = packed"))), /done is orderState = packed, but its last lane ordersToPick leaves a record at orderState = picking/);
  // A package that extends nothing is still checked whole at publish.
  refused(flow.replace("ordersToPack -> pack", "ordersToShip -> ship"), /ordersToShip isn't a lane/);
});

test("a block stop's with (revision 36): the values its form opens with are read, carried, printed back and checked", () => {
  const locked = flow.replace("    order of order", "    order of order with buyer = walk-in, total = 0");
  const [info] = readPackages(shop(locked));
  assert.deepEqual(info?.flows[0]?.stops[0]?.with, [{ facet: "buyer", value: "walk-in" }, { facet: "total", value: "0" }]);
  assert.equal(info?.flows[0]?.stops[1]?.with, undefined);
  checkPackages(shop(locked));
  const first = bundleOf(parsePackage(shop(locked)));
  const stops = (first.flows as { stops: JsonLike[] }[])[0]?.stops;
  assert.deepEqual(stops?.[0], { name: "order", of: "order", with: [{ facet: "buyer", value: "walk-in" }, { facet: "total", value: "0" }] });
  assert.match(printBundle(first), /^    order of order with buyer = walk-in, total = 0$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  // The flow as written before says nothing new: no `with` in its bundle.
  assert.ok(!("with" in ((bundleOf(parsePackage(shop(flow))).flows as { stops: object[] }[])[0]?.stops[0] ?? {})));
  const bad = (line: string, why: RegExp) => refused(flow.replace("    order of order", line), why);
  bad("    order of order with colour = red", /locks colour, which isn't a facet/);
  bad("    order of order with buyer", /a stop's with is/);
  bad("    order of order with buyer = a, buyer = b", /locks a facet twice/);
  // A lane stop takes no with: only a block opens a form.
  assert.throws(() => readPackages(shop(flow.replace("ordersToPick -> pick", "ordersToPick -> pick with buyer = a"))), /a stop is/);
});
type JsonLike = { [k: string]: unknown };
