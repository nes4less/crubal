// The order of versions (11.4, 11.5): the date as text, then a same-day suffix as a number (`.10` follows
// `.9`); a new cut never goes earlier than the version it follows (versions written ahead of the calendar,
// 2026-11-03).
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, latestVersion, nextVersion } from "../src/versions.ts";

test("versions order by date, then by the suffix as a number", () => {
  assert.ok(compareVersions("2026-12-31.10", "2026-12-31.9") > 0);
  assert.ok(compareVersions("2026-12-31", "2026-12-31.2") < 0);
  assert.equal(compareVersions("2026-12-31", "2026-12-31.1"), 0);
  assert.ok(compareVersions("2027-01-01", "2026-12-31.12") > 0);
  assert.equal(latestVersion(["2026-12-31.9", "2026-12-31.10", "2026-12-30"]), "2026-12-31.10");
  assert.equal(latestVersion([]), undefined);
});

test("a new cut takes its date, a suffix the same day, and carries on a later version's date when behind it", () => {
  assert.equal(nextVersion("2026-11-03"), "2026-11-03");
  assert.equal(nextVersion("2026-11-04", "2026-11-03"), "2026-11-04");
  assert.equal(nextVersion("2026-11-03", "2026-11-03"), "2026-11-03.2");
  assert.equal(nextVersion("2026-11-03", "2026-11-03.9"), "2026-11-03.10");
  assert.equal(nextVersion("2026-11-03", "2026-12-31"), "2026-12-31.2", "never earlier than the one it follows");
  assert.equal(nextVersion("2026-11-03", "2026-12-31.4"), "2026-12-31.5");
});
