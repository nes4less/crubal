// A form body is JSON, so chapter 3's forms arrive as values: a boolean for a yes-no, `{"$link"}` for a link,
// `{"$image"}` for an image, and a list read item by item for a many-valued facet. Each lands as itself; none
// is serialized into text and misread as a detail or a spelling.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { Exchange } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";

const DEFS = `kind: deployment
  levels: deployment
kind: location
  levels: location
deploymentName$
emailSending?
logo^
shippingOrigin&location
marketplaceKinds$*
`;
const CONTRACTS = `contract: settings
  kind: form
  origin: declared
  needs:
    emailSending
    logo
    shippingOrigin
    marketplaceKinds
`;

test("a boolean, a $link, an $image and a list land as values through a form", () => {
  const ex = new Exchange(readDefinitions(DEFS), readContracts(CONTRACTS), [], []);
  ex.put({ id: "ROOT", kind: "deployment", level: "deployment", owner: "s", values: { deploymentName: "Shop" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  const r = ex.receiveRun(
    "settings",
    "ROOT",
    JSON.stringify({ emailSending: false, logo: { $image: "https://shop.example/logo.png" }, shippingOrigin: { $link: "K-1" }, marketplaceKinds: ["item", "product"] }),
    "P-1",
  );
  assert.equal(r.stopped, undefined, JSON.stringify(r));
  const outcomes = r.outcomes as { to?: string; outcome: string }[];
  assert.deepEqual(
    outcomes.map((o) => [o.to, o.outcome]),
    [
      ["emailSending", "absorbed"],
      ["logo", "absorbed"],
      ["shippingOrigin", "absorbed"],
      ["marketplaceKinds", "absorbed"],
    ],
  );
  const v = ex.get("ROOT")?.values ?? {};
  assert.equal(v.emailSending, false);
  assert.deepEqual(v.logo, { $image: "https://shop.example/logo.png" });
  assert.deepEqual(v.shippingOrigin, { $link: "K-1" });
  assert.deepEqual(v.marketplaceKinds, ["item", "product"]);
});

test("the same values as text still read: yes, &K-1, a comma list", () => {
  const ex = new Exchange(readDefinitions(DEFS), readContracts(CONTRACTS), [], []);
  ex.put({ id: "ROOT", kind: "deployment", level: "deployment", owner: "s", values: { deploymentName: "Shop" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  const r = ex.receiveRun("settings", "ROOT", JSON.stringify({ emailSending: "yes", shippingOrigin: "&K-2", marketplaceKinds: "item, unit" }), "P-1");
  assert.equal(r.stopped, undefined);
  const v = ex.get("ROOT")?.values ?? {};
  assert.equal(v.emailSending, true);
  assert.deepEqual(v.shippingOrigin, { $link: "K-2" });
  assert.deepEqual(v.marketplaceKinds, ["item", "unit"]);
});
