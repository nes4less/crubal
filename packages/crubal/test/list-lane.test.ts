// A list (spec 12.10, revision 17): a lane without a pick holds every record its view serves; it has no
// done and no history, and one that names a done is refused.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { checkPackages, readPackages } from "../src/packages.ts";

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

const list = `lane: ordersAll /2026-11-05
  label: Every order
  utility: orders
  view: desk
  band: rarely
  house: 9
  serves: owner
  home:
    figure: count
    press: All -> /orders
  card:
    name: buyer`;

test("a lane without a pick is a list: read, checked, carried into the bundle and back", () => {
  const [info] = readPackages(shop(list));
  const l = info?.lanes.find((x) => x.name === "ordersAll");
  assert.equal(l?.pick, undefined);
  assert.equal(l?.done, undefined);
  checkPackages(shop(list));
  const first = bundleOf(parsePackage(shop(list)));
  assert.match(printBundle(first), /^lane: ordersAll \/2026-11-05$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
});

test("a list names no done", () => {
  assert.throws(
    () => readPackages(shop(list.replace("  band: rarely", "  done: orderState = shipped\n  band: rarely"))),
    /is a list \(no pick\), so it has no done/,
  );
});
