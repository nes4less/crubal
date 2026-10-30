// The `subject:` block (spec 12.10): a row of the grid a package declares. Read with its parts, carried
// into the bundle and back, versioned in `members`, and refused at publish when it names a view, filter,
// value, slot or act the package doesn't declare, or serves wider than its view shows.

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

permissions: shop
  menu:
    pick: run pick
  presets:
    fulfiller: pick    audience: staff
  relations: buyer, follower only

utility: orders /2026-11-05
  label: Orders
  serves: owner, fulfiller(pick)
  acts: pick, pack, confirmAddress

${tail}
`;

const toPick = `subject: ordersToPick /2026-11-05
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
    word: one "order is paid and waiting to be picked." many "orders are paid and waiting to be picked."
    press: Pick -> /orders?tab=pick
    chips: orderState
  card:
    name: id, buyer
    sub: state
    lines: total, placed
    state: state
    moment: placed
    figure: total
    primary: Pick -> pick
    quiet: Open -> page
    quick: "Confirm address" -> confirmAddress
    opens: page`;

const setup = `subject: setup /2026-11-05
  label: Setup
  utility: orders
  serve: setup
  band: rarely
  house: 0
  serves: owner
  home:
    word: one "step done" many "steps done"
    press: Open Setup -> /setup`;

test("a subject block is read with its parts", () => {
  const [info] = readPackages(shop(toPick));
  const s = info?.subjects[0];
  assert.equal(s?.name, "ordersToPick");
  assert.equal(s?.version, "2026-11-05");
  assert.equal(s?.view, "desk");
  assert.deepEqual([s?.pick?.filter, s?.pick?.value], ["orderState", "paid"]);
  assert.deepEqual(s?.done, { filter: "orderState", value: "picking", line: s?.done !== "viewed" ? s?.done?.line : 0 });
  assert.equal(s?.band, "daily");
  assert.equal(s?.house, 7);
  assert.deepEqual(s?.serves.map((x) => [x.as, x.items]), [["owner", undefined], ["fulfiller", ["pick"]]]);
  assert.deepEqual(s?.home.figure, { of: "count" });
  assert.deepEqual(s?.home.word, { one: "order is paid and waiting to be picked.", many: "orders are paid and waiting to be picked." });
  assert.deepEqual([s?.home.press?.word, s?.home.press?.to], ["Pick", "/orders?tab=pick"]);
  assert.deepEqual(s?.card?.name, ["id", "buyer"]);
  assert.deepEqual([s?.card?.primary?.word, s?.card?.primary?.to], ["Pick", "pick"]);
  assert.deepEqual(s?.card?.quick.map((q) => [q.word, q.to]), [["Confirm address", "confirmAddress"]]);
  assert.equal(info?.utilities[0]?.acts.map((a) => a.name).join(","), "pick,pack,confirmAddress");
  checkPackages(shop(toPick));
});

test("a utility's own subject names a serve and no view; done may be viewed", () => {
  const [info] = readPackages(shop(setup));
  assert.equal(info?.subjects[0]?.serve, "setup");
  checkPackages(shop(setup));
  const viewed = toPick.replace("done: orderState = picking", "done: viewed");
  assert.equal(readPackages(shop(viewed))[0]?.subjects[0]?.done, "viewed");
  checkPackages(shop(viewed));
});

test("a subject round-trips through its bundle and is versioned in members", () => {
  const first = bundleOf(parsePackage(shop(toPick)));
  const subjects = first.subjects as { subject: string; card: { quick: { word: string; to: string }[] } }[];
  assert.equal(subjects[0]?.subject, "ordersToPick");
  assert.deepEqual(subjects[0]?.card.quick, [{ word: "Confirm address", to: "confirmAddress" }]);
  assert.deepEqual((first.utilities as { acts: string[] }[])[0]?.acts, ["pick", "pack", "confirmAddress"]);
  const text = printBundle(first);
  assert.match(text, /^subject: ordersToPick \/2026-11-05$/m);
  assert.match(text, /^    quick: "Confirm address" -> confirmAddress$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  const { bundle } = publish(shop(toPick), { date: "2026-11-06" });
  assert.equal((bundle.members as { [k: string]: string })["subject:ordersToPick"], "2026-11-06");
});

const refused = (tail: string, why: RegExp) => assert.throws(() => checkPackages(shop(tail)), (e: unknown) => e instanceof CrubalError && why.test(e.message));

test("a subject is refused when it names what the package doesn't declare", () => {
  refused(toPick.replace("view: desk", "view: shelf"), /names the view shelf/);
  refused(toPick.replace("pick: orderState = paid", "pick: orderState = lost"), /lost is not a value/);
  refused(toPick.replace("pick: orderState = paid", "pick: region = us"), /region, which isn't a filter/);
  refused(toPick.replace("lines: total, placed", "lines: total, weight"), /weight, which isn't a slot/);
  refused(toPick.replace("primary: Pick -> pick", "primary: Ship -> ship"), /ship isn't an act/);
  refused(toPick.replace("utility: orders", "utility: returns"), /utility returns, which this package doesn't declare/);
  refused(toPick.replace("chips: orderState", "chips: placedMonth"), /placedMonth, which isn't a filter/);
  refused(toPick.replace("opens: page", "opens: nest"), /nest is not in this language version/);
  refused(toPick.replace("serves: owner, fulfiller(pick)", "serves: member"), /wider than desk shows/);
  refused(`${toPick}\n${toPick}`, /twice in one package/);
});
