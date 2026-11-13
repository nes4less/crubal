// The `flow:` block (spec 12.11): an objective's line of stops over the package's lanes and forms. Read
// with its parts, carried into the bundle and back, versioned in `members`, and refused at publish when a
// stop names neither a lane nor a form of the package, an act its utility lacks, or a done that is no filter.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, emptyParsed, parsePackage, printBundle, readBundle, readBundleOnto } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { checkPermissions, readAccess } from "../src/access.ts";
import { emptyDictionary } from "../src/defs.ts";
import { askWords, casePress, checkFlowsInForce, checkPackages, flowJoins, flowStamps, readPackages } from "../src/packages.ts";
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

test("a flow's joins are read, never refused (revision 40); it is refused when its done is not its last lane's, or a stop is a list with no act", () => {
  // Revision 40: two stops whose states do not hand on are no mistake to refuse. The joins say where a record
  // passes and where it does not; what stands together otherwise is the flow's context or its order.
  const backwards = flow.replace("    ordersToPick -> pick\n    ordersToPack -> pack", "    ordersToPack -> pack\n    ordersToPick -> pick");
  assert.notEqual(backwards, flow);
  const joinsOf = (text: string) => {
    const [p] = readPackages(shop(text));
    return flowJoins(p?.flows[0] as never, p?.lanes ?? []).map((j) => `${j.from}>${j.to}:${j.passes}`);
  };
  assert.deepEqual(joinsOf(flow), ["ordersToPick>ordersToPack:true"]);
  assert.deepEqual(joinsOf(backwards), ["ordersToPack>ordersToPick:false"]);
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

test("a flow in an extending package may name the lanes, forms, utility and presets it extends; the check in force refuses what a publish would", () => {
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
  // A lane nobody declares, a done that is not the last lane's: refused in force, as a publish would have.
  assert.throws(() => checkFlowsInForce(inForce(own("    ordersToPick -> pick\n    ordersToShip -> ship"))), /ordersToShip isn't a lane in force here/);
  // Revision 40: stops that hand nothing on are in force as they stand.
  checkFlowsInForce(inForce(own("    ordersToPack -> pack\n    ordersToPick -> pick", "orderState = picking")));
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

test("revision 40: a record passes to a step lane that waits after the step before it; a block between two lanes leaves their join; links of different levels pass nothing", () => {
  const stops = (...names: string[]) => ({ stops: names.map((name) => ({ name })) }) as never;
  const steps = [
    { name: "toPull", step: "pulled" },
    { name: "toPack", step: "packed", after: ["pulled"] },
    { name: "toShip", step: "shipped" },
  ];
  assert.deepEqual(
    flowJoins(stops("toPull", "toPack", "toShip"), steps).map((j) => j.passes),
    [true, false],
    "packed waits after pulled; shipped names no after",
  );
  const states = [
    { name: "boxesToCount", pick: { filter: "counting", value: "open" } },
    { name: "unitsExpected", pick: { filter: "countState", value: "expected" }, done: { filter: "countState", value: "found" } },
    { name: "unitsFound", pick: { filter: "countState", value: "found" } },
  ];
  assert.deepEqual(
    flowJoins(stops("boxesToCount", "unitsExpected", "aForm", "unitsFound"), states as never),
    [
      { from: "boxesToCount", to: "unitsExpected", at: 1, passes: false },
      { from: "unitsExpected", to: "unitsFound", at: 3, passes: true },
    ],
  );
  assert.deepEqual(flowJoins(stops("unitsExpected"), states as never), [], "one link joins nothing");
});

// Revision 41: a link's cases.
const cased = flow.replace(
  "    ordersToPick -> pick\n",
  `    ordersToPick -> pick
      already: ignore
      stranger: ask
        yes: Pick it here -> pick
        no: Put it back
        or: Hold it -> pack
      flag packing: no when any ordersToPack where heldFor = record
        yes: Pack now -> pack on found, pick
        no: Leave it -> pick
`,
);
const linked = (tail: string) => shop(tail).replace("buyer$\n", "buyer$\nheldFor&order\n");

test("revision 41: a link's cases are read with their answers and presses, carried, printed back, and answered", () => {
  assert.notEqual(cased, flow);
  checkPackages(linked(cased));
  const st = readPackages(linked(cased))[0]?.flows[0]?.stops[1];
  assert.equal(st?.already, "ignore");
  assert.deepEqual(st?.cases?.map((c) => `${c.kind}:${c.name ?? ""}:${c.answer}`), ["stranger::ask", "flag:packing:no"]);
  const [stranger, flag] = st?.cases ?? [];
  assert.deepEqual(stranger?.yes, { word: "Pick it here", runs: [{ act: "pick" }] });
  assert.deepEqual(stranger?.no, { word: "Put it back", runs: [] });
  assert.deepEqual(stranger?.or, [{ word: "Hold it", runs: [{ act: "pack" }] }]);
  assert.deepEqual(flag?.when, { lane: "ordersToPack", facet: "heldFor" });
  assert.deepEqual(flag?.yes.runs, [{ act: "pack", onFound: true }, { act: "pick" }]);
  // Three answers: ask gives no press; yes and no give theirs; a place's own answer stands over the declared one.
  assert.equal(casePress(stranger as never), undefined);
  assert.equal(casePress(flag as never)?.word, "Leave it");
  assert.equal(casePress(flag as never, "yes")?.word, "Pack now");
  assert.equal(casePress(flag as never, "ask"), undefined);
  // Carried, printed, read again the same.
  const b = bundleOf(parsePackage(linked(cased)));
  const text = printBundle(b);
  assert.match(text, /^ {6}already: ignore$/m);
  assert.match(text, /^ {6}stranger: ask$/m);
  assert.match(text, /^ {8}or: Hold it -> pack$/m);
  assert.match(text, /^ {6}flag packing: no when any ordersToPack where heldFor = record$/m);
  assert.match(text, /^ {8}yes: Pack now -> pack on found, pick$/m);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
  // A stop with none prints none.
  assert.doesNotMatch(printBundle(bundleOf(parsePackage(shop(flow)))), /already:|stranger:|flag /);
});

test("revision 41: a link's cases are refused when malformed or naming what is not there", () => {
  const no = (from: string, to: string, why: RegExp) => {
    const text = cased.replace(from, to);
    assert.notEqual(text, cased, from);
    assert.throws(() => checkPackages(linked(text)), (e: unknown) => e instanceof CrubalError && why.test(e.message), from);
  };
  no("stranger: ask", "stranger: maybe", /answer is ask, yes or no, not maybe/);
  no("        no: Put it back\n", "", /the stranger at ordersToPick needs a yes and a no/);
  no("or: Hold it -> pack", "or: Put it back", /offers one word twice/);
  no("yes: Pick it here -> pick", "yes: Pick it here -> refund", /the press Pick it here runs refund, which isn't an act of orders/);
  no("yes: Pick it here -> pick", "yes: Pick it here -> pick on found", /only a flag's press runs an act on found/);
  no("or: Hold it -> pack", "or: Hold it -> returns.take", /names the utility returns/);
  no("already: ignore", "already: twice", /already is ignore or stamp, not twice/);
  no(" when any ordersToPack where heldFor = record", "", /the flag packing says no when/);
  no("any ordersToPack where", "any ordersToShip where", /ordersToShip isn't a lane/);
  no("where heldFor = record", "where total = record", /total isn't a link/);
  no("where heldFor = record", "where heldBy = record", /heldBy isn't a facet/);
  no("flag packing: no when", "flag packing: no when\n", /beneath a stop stands|says no when/);
  no("      stranger: ask\n", "      stranger: ask\n        yes: A\n        no: B\n      stranger: ask\n", /has one stranger/);
  // A stop with no act is no link, and a block has no cases.
  assert.throws(() => checkPackages(linked(flow.replace("    order of order\n", "    order of order\n      already: ignore\n"))), /names no act, so it has no cases/);
});

// Revision 42: a closed set.
// Revision 48: the questions a link asks and offers.
const asking = flow.replace(
  "    ordersToPick -> pick\n",
  `    ordersToPick -> pick
      asks many: pack when record.lineCount > 1 "How many did you pick?"
      asks none: pack when record.lineCount <= 0 and no record.buyer open 1
      offers: pack
`,
);
const counted = (tail: string) => shop(tail).replace("buyer$\n", "buyer$\nlineCount#\n");

test("revision 48: a link says the questions it asks in place of its stamp, each an act's under a when over the record touched, and the acts it offers; read, carried, printed back; refused when malformed or naming what is not there", () => {
  assert.notEqual(asking, flow);
  checkPackages(counted(asking));
  const st = readPackages(counted(asking))[0]?.flows[0]?.stops[1];
  assert.deepEqual(st?.asks?.map((q) => [q.name, q.act, q.open, q.words, q.when.and?.length]), [["many", "pack", undefined, "How many did you pick?", undefined], ["none", "pack", "1", undefined, 1]]);
  assert.deepEqual(st?.offers, [{ act: "pack" }]);
  const b = bundleOf(parsePackage(counted(asking)));
  const text = printBundle(b);
  assert.match(text, /^ {6}asks many: pack when record\.lineCount > 1 "How many did you pick\?"$/m);
  assert.match(text, /^ {6}asks none: pack when record\.lineCount <= 0 and no record\.buyer open 1$/m);
  assert.match(text, /^ {6}offers: pack$/m);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
  assert.doesNotMatch(printBundle(bundleOf(parsePackage(shop(flow)))), /asks |offers:/);
  const no = (from: string, to: string, why: RegExp) => {
    const t = asking.replace(from, to);
    assert.notEqual(t, asking, from);
    assert.throws(() => checkPackages(counted(t)), (e: unknown) => e instanceof CrubalError && why.test(e.message), from);
  };
  no("asks none: pack", "asks many: pack", /asks many twice/);
  no("asks many: pack when", "asks many: refund when", /asks many: refund isn't among orders's acts/);
  no("offers: pack", "offers: refund", /offers: refund isn't among orders's acts/);
  no("record.lineCount > 1", "record.nope > 1", /record\.nope isn't a facet|nope isn't a facet/);
  no("record.lineCount > 1", "context.order.lineCount > 1", /a link's when reads record\.<facet>/);
  // Revision 51: an ask's words say a value of the record touched.
  const said = asking.replace('"How many did you pick?"', '"{record.lineCount} lines for {record.buyer}. How many did you pick?"');
  assert.notEqual(said, asking);
  checkPackages(counted(said));
  const words = readPackages(counted(said))[0]?.flows[0]?.stops[1]?.asks?.[0]?.words ?? "";
  assert.equal(askWords(words, { values: { lineCount: "3", buyer: "Pat" } }), "3 lines for Pat. How many did you pick?");
  assert.equal(askWords(words, { values: { lineCount: { $qty: "2", unit: "ea" } } }), "2 lines for . How many did you pick?");
  assert.throws(() => checkPackages(counted(said.replace("{record.buyer}", "{record.nope}"))), (e: unknown) => e instanceof CrubalError && /nope isn't a facet/.test(e.message));
  assert.throws(() => checkPackages(counted(said.replace("{record.buyer}", "{buyer}"))), (e: unknown) => e instanceof CrubalError && /its words say \{record\.<facet>\}/.test(e.message));
});

const third = `lane: ordersToShip /2026-11-05
  label: Orders to ship
  utility: orders
  view: desk
  pick: orderState = packed
  band: daily
  house: 7
  serves: owner
  home:
    figure: count
    press: Ship -> /orders
  card:
    name: buyer
    primary: Ship -> ship

`;
const closedFlow = flow
  .replace("  stops:\n", "  closed: ordersToPick to ordersToShip over ordersToPack cancel pack\n  stops:\n")
  .replace("    ordersToPack -> pack\n", "    ordersToPack -> pack\n    ordersToShip -> ship\n");

test("revision 42: a flow says it is a closed set: its start, its finish, its rest and its cancel; read, checked, carried and printed back", () => {
  assert.notEqual(closedFlow, flow);
  const src = shop(third + closedFlow);
  checkPackages(src);
  const cl = readPackages(src)[0]?.flows[0]?.closed;
  assert.deepEqual([cl?.start, cl?.finish, cl?.rest, cl?.cancel], ["ordersToPick", "ordersToShip", "ordersToPack", "pack"]);
  const bundle = bundleOf(parsePackage(src));
  assert.match(printBundle(bundle), /^  closed: ordersToPick to ordersToShip over ordersToPack cancel pack$/m);
  assert.equal(serialize(bundleOf(readBundle(bundle))), serialize(bundle));
  const no = (from: string, to: string, why: RegExp) => {
    const text = closedFlow.replace(from, to);
    assert.notEqual(text, closedFlow, from);
    assert.throws(() => checkPackages(shop(third + text)), (e: unknown) => e instanceof CrubalError && why.test(e.message), from);
  };
  no("closed: ordersToPick to", "closed: nowhere to", /starts at nowhere, which isn't a lane stop of it/);
  no("over ordersToPack", "over ordersToPick", /are three stops/);
  no("closed: ordersToPick to ordersToShip", "closed: ordersToShip to ordersToPick", /finishes at ordersToPick before it starts at ordersToShip/);
  no("cancel pack", "cancel burn", /cancels by burn, which isn't an act of orders/);
  no("closed: ordersToPick to ordersToShip over ordersToPack cancel pack", "closed: ordersToPick", /closed is "<start stop> to <finish stop> over <rest stop>"/);
  no("    ordersToShip -> ship\n", "    ordersToShip\n", /its stop ordersToShip names no act/);
});

test("revision 54: a when tests a value against a word written there, `<ref> is <word>` and `is not`; read, carried, printed back; a value not set is not the word", async () => {
  const { readWhen, whenHolds, whenJson, whenText } = await import("../src/acts.ts");
  const on = (values: { [k: string]: string }) => ({ record: { id: "U-1", values }, context: {}, found: {}, now: "" });
  const is = readWhen("record.stale is yes and record.qty > 0", 1);
  assert.equal(whenText(whenJson(is)), "record.stale is yes and record.qty > 0");
  assert.equal(whenHolds(is, on({ stale: "yes", qty: "2" })), true);
  assert.equal(whenHolds(is, on({ stale: "no", qty: "2" })), false);
  assert.equal(whenHolds(is, on({ qty: "2" })), false, "not set is not yes");
  const not = readWhen("record.stale is not yes", 1);
  assert.equal(whenText(whenJson(not)), "record.stale is not yes");
  assert.equal(whenHolds(not, on({ stale: "no" })), true);
  assert.equal(whenHolds(not, on({})), true, "not set is not yes");
  assert.equal(whenHolds(not, on({ stale: "yes" })), false);
  // On a link: the ask is read and printed back with it.
  const flow = `flow: pick /2026-11-13\n  label: Pick\n  utility: fulfillment\n  stops:\n    toPick -> pack\n      asks odd: pack when record.state is not ready "Not ready. Pack it anyway?"\n`;
  assert.match(printBundle(bundleOf(parsePackage(shop(flow)))), /^ {6}asks odd: pack when record\.state is not ready "Not ready\. Pack it anyway\?"$/m);
});
