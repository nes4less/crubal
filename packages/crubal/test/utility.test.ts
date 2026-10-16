// The `utility:` block (spec 11.1): read as a member, carried into the bundle and back, versioned in
// `members`, and refused at publish when it serves or narrows to a name the package doesn't declare or
// needs a setting that isn't a facet.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { checkPackages, readPackages } from "../src/packages.ts";
import { publish } from "../src/publish.ts";
import { serialize } from "../src/canonical.ts";
import { CrubalError } from "../src/tree.ts";

const shop = (utility: string) => `package: shop /2026-10-16
  owner: shop.example
  crubal: 2

kind: order
  levels: order, line
state{placed|shipped}
shippingOrigin$

contract: ship
  kind: form
  needs:
    state

permissions: shop
  menu:
    ship: run ship
    returns: see state
  presets:
    fulfiller: ship, returns    audience: staff
  relations: buyer, follower only

${utility}
`;

const orders = `utility: orders /2026-10-16
  label: Orders
  serves: owner, fulfiller(ship, returns), member(buyer)
  needs: shop.example/shop /2026-10-16, notifications
  setup: connection stripe, setting shippingOrigin`;

test("a utility block is read with its parts", () => {
  const [info] = readPackages(shop(orders));
  assert.equal(info?.utilities.length, 1);
  const u = info?.utilities[0];
  assert.equal(u?.name, "orders");
  assert.equal(u?.version, "2026-10-16");
  assert.equal(u?.label, "Orders");
  assert.deepEqual(u?.serves.map((s) => [s.as, s.items]), [["owner", undefined], ["fulfiller", ["ship", "returns"]], ["member", ["buyer"]]]);
  assert.deepEqual(u?.needs.map((n) => [n.name, n.version]), [["shop.example/shop", "2026-10-16"], ["notifications", undefined]]);
  assert.deepEqual(u?.setup.map((s) => ("connection" in s ? `connection ${s.connection}` : `setting ${s.setting}`)), ["connection stripe", "setting shippingOrigin"]);
  checkPackages(shop(orders));
});

test("a utility round-trips through its bundle and is versioned in members", () => {
  const first = bundleOf(parsePackage(shop(orders)));
  assert.deepEqual(first.utilities, [
    { utility: "orders", version: "2026-10-16", label: "Orders", serves: [{ as: "owner" }, { as: "fulfiller", items: ["ship", "returns"] }, { as: "member", items: ["buyer"] }], needs: [{ name: "shop.example/shop", version: "2026-10-16" }, { name: "notifications" }], setup: [{ connection: "stripe" }, { setting: "shippingOrigin" }] },
  ]);
  const text = printBundle(first);
  assert.match(text, /^utility: orders \/2026-10-16$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  const { bundle } = publish(shop(orders), { date: "2026-10-17" });
  assert.equal((bundle.members as { [k: string]: string })["utility:orders"], "2026-10-17");
  const again = publish(shop(orders), { date: "2026-10-18", previous: bundle });
  assert.equal((again.bundle.members as { [k: string]: string })["utility:orders"], "2026-10-17", "an unchanged utility keeps its version");
});

const refuses = (utility: string, message: RegExp) => {
  assert.throws(() => checkPackages(shop(utility)), (e: unknown) => e instanceof CrubalError && message.test(e.message), `expected ${message}`);
};

test("a utility serving or narrowing to a name the package doesn't declare is refused, as is a setting that isn't a facet", () => {
  refuses("utility: orders /2026-10-16\n  serves: picker", /serves picker, which isn't a preset, relation or audience/);
  refuses("utility: orders /2026-10-16\n  serves: fulfiller(pick)", /fulfiller\(pick\): pick isn't a preset, menu item or relation/);
  refuses("utility: orders /2026-10-16\n  serves: owner\n  setup: setting warehouse", /setting warehouse, which isn't a facet/);
  refuses("utility: orders /2026-10-16\n  serves: owner\n  setup: credential stripe", /not "connection <name>" or "setting <facet>"/);
  refuses("utility: orders /2026-10-16\n  serves: owner\n  needs: orders", /needs itself/);
  refuses("utility: Orders /2026-10-16\n  serves: owner", /the name a lower-case word/);
  refuses("utility: orders /2026-10-16\n  serves: owner\nutility: orders /2026-10-16\n  serves: owner", /twice in one package/);
});
