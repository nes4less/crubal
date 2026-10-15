// schedule.ts: scheduled triggers (spec 7.11). A schedule is a contract's `when`: `every day at 03:00`,
// `every hour`, `every 15 minutes`, `every monday at 09:00`, `every month on 1 at 00:00`, with an optional
// zone on the time of day. Ticks are computed from the schedule and the caller's `now`, never remembered by
// a clock, so every store agrees on them.

import { CrubalError } from "./tree.ts";

export type Schedule = {
  text: string;
  /** `minutes`, `hours`, `day`, `week` or `month`. */
  unit: "minutes" | "hours" | "day" | "week" | "month";
  /** For minutes and hours. */
  every: number;
  /** For day, week and month: the time of day, as minutes from midnight. */
  minute: number;
  /** For week: 0 (Sunday) to 6. */
  weekday?: number;
  /** For month: 1 to 28. */
  monthday?: number;
  /** An IANA zone for the time of day; UTC when absent. */
  zone?: string;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function isSchedule(when: string | undefined): boolean {
  return !!when && /^every /.test(when.trim());
}

/** Read a schedule, or refuse it in plain words. */
export function readSchedule(text: string, line?: number): Schedule {
  let s = text.trim();
  let zone: string | undefined;
  const z = s.match(/\s*\[zone: ([^\]]+)\]$/);
  if (z) {
    zone = (z[1] as string).trim();
    s = s.slice(0, z.index).trim();
  }
  const base = { text: text.trim(), ...(zone ? { zone } : {}) };
  let m = s.match(/^every (\d+) (minutes?|hours?)$/);
  if (m) {
    const every = Number(m[1]);
    if (every < 1) throw new CrubalError(`a schedule repeats at least every 1: ${text}`, line);
    return { ...base, unit: (m[2] as string).startsWith("minute") ? "minutes" : "hours", every, minute: 0 };
  }
  m = s.match(/^every (minute|hour)$/);
  if (m) return { ...base, unit: m[1] === "minute" ? "minutes" : "hours", every: 1, minute: 0 };
  const time = (t: string | undefined): number => {
    const tm = (t ?? "00:00").match(/^(\d{2}):(\d{2})$/);
    if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) throw new CrubalError(`a time of day is hh:mm: ${text}`, line);
    return Number(tm[1]) * 60 + Number(tm[2]);
  };
  m = s.match(/^every day(?: at (\S+))?$/);
  if (m) return { ...base, unit: "day", every: 1, minute: time(m[1]) };
  m = s.match(/^every (sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?: at (\S+))?$/);
  if (m) return { ...base, unit: "week", every: 1, minute: time(m[2]), weekday: WEEKDAYS.indexOf(m[1] as string) };
  m = s.match(/^every month on (\d{1,2})(?: at (\S+))?$/);
  if (m) {
    const d = Number(m[1]);
    if (d < 1 || d > 28) throw new CrubalError(`a monthly schedule names a day from 1 to 28, so every month has it: ${text}`, line);
    return { ...base, unit: "month", every: 1, minute: time(m[2]), monthday: d };
  }
  throw new CrubalError(`can't read the schedule "${text}": every N minutes|hours, every day at hh:mm, every <weekday> at hh:mm, every month on D at hh:mm`, line);
}

const MIN = 60_000;

/** The wall-clock parts of an instant in a zone. */
function partsIn(ms: number, zone: string | undefined): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const dt = new Date(ms);
  if (!zone) return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes(), wd: dt.getUTCDay() };
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  const p: { [k: string]: string } = {};
  for (const x of f.formatToParts(dt)) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "Sun") };
}

/** The instant of a wall-clock date and minute in a zone (UTC when none). */
function instantOf(y: number, mo: number, d: number, minute: number, zone: string | undefined): number {
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minute / 60), minute % 60);
  if (!zone) return guess;
  // Correct the UTC guess by the zone's offset at that moment (one more pass settles a DST edge).
  let ms = guess;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(ms, zone);
    const local = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    ms += guess - local;
  }
  return ms;
}

export function moment(ms: number): string {
  return new Date(ms).toISOString().replace(/:00\.000Z$/, "Z").replace(/\.000Z$/, "Z");
}

export function instant(s: string): number {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new CrubalError(`not a moment: ${s}`);
  return ms;
}

/** The first tick strictly after `after` (a moment). */
export function nextTick(sch: Schedule, after: string): string {
  const a = instant(after);
  if (sch.unit === "minutes" || sch.unit === "hours") {
    const step = sch.every * (sch.unit === "minutes" ? MIN : 60 * MIN);
    return moment((Math.floor(a / step) + 1) * step);
  }
  const p = partsIn(a, sch.zone);
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const wd = day.getUTCDay();
    if (sch.unit === "week" && wd !== sch.weekday) continue;
    if (sch.unit === "month" && d !== sch.monthday) continue;
    const t = instantOf(y, mo, d, sch.minute, sch.zone);
    if (t > a) return moment(t);
  }
  throw new CrubalError(`no tick of "${sch.text}" within 400 days of ${after}`);
}

/** Every tick after `after` and at or before `now`, in order. With no `after` the schedule hasn't begun: none. */
export function ticksDue(sch: Schedule, after: string | undefined, now: string): string[] {
  const out: string[] = [];
  if (after === undefined) return out;
  let cur = after;
  const end = instant(now);
  for (let i = 0; i < 100_000; i++) {
    const t = nextTick(sch, cur);
    if (instant(t) > end) break;
    out.push(t);
    cur = t;
  }
  return out;
}
