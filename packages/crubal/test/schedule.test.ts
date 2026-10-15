import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick, readSchedule, ticksDue } from "../src/schedule.ts";
import { CrubalError } from "../src/tree.ts";

test("ticks follow from the schedule and a moment alone", () => {
  assert.equal(nextTick(readSchedule("every day at 03:00"), "2026-10-15T02:59Z"), "2026-10-15T03:00Z");
  assert.equal(nextTick(readSchedule("every day at 03:00"), "2026-10-15T03:00Z"), "2026-10-16T03:00Z");
  assert.equal(nextTick(readSchedule("every 15 minutes"), "2026-10-15T03:07Z"), "2026-10-15T03:15Z");
  assert.equal(nextTick(readSchedule("every monday at 09:00"), "2026-10-15T12:00Z"), "2026-10-19T09:00Z");
  assert.equal(nextTick(readSchedule("every month on 1 at 00:00"), "2026-10-15T12:00Z"), "2026-11-01T00:00Z");
});

test("a zone moves the tick to the instant that wall-clock time names", () => {
  // 03:00 in Chicago on 2026-10-15 (CDT, UTC-5) is 08:00Z.
  assert.equal(nextTick(readSchedule("every day at 03:00 [zone: America/Chicago]"), "2026-10-15T00:00Z"), "2026-10-15T08:00Z");
});

test("every tick after the last and at or before now is due", () => {
  assert.deepEqual(ticksDue(readSchedule("every day at 03:00"), "2026-10-15T03:00Z", "2026-10-17T04:00Z"), ["2026-10-16T03:00Z", "2026-10-17T03:00Z"]);
  assert.deepEqual(ticksDue(readSchedule("every day at 03:00"), "2026-10-15T03:00Z", "2026-10-15T23:00Z"), []);
  assert.deepEqual(ticksDue(readSchedule("every day at 03:00"), undefined, "2026-10-15T23:00Z"), [], "a schedule that hasn't begun owes nothing");
});

test("a schedule the grammar doesn't have is refused in plain words", () => {
  assert.throws(() => readSchedule("every fortnight", 3), (e: unknown) => e instanceof CrubalError && e.line === 3);
  assert.throws(() => readSchedule("every month on 31", 4), (e: unknown) => e instanceof CrubalError && e.line === 4);
});
