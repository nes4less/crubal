// surface.ts: the surface a place's packages declare, and the lines that grant or withhold it (14.14,
// revision 43). A utility holds its chains (flows) and its lanes; a chain holds its links (stops); a link holds
// its cases' presses; a lane outside a chain holds its presses. Each has an address, a path of names. A line
// says see or run of an address, yes or no; the deepest line on the way to an address decides, and a no beats
// a yes at the same depth. Pure: no store, no caller. Who holds which lines is the edge's (access.ts).

import type { Flow, Lane, Utility } from "./packages.ts";
import { CrubalError } from "./tree.ts";

export const SURFACE_VERBS = ["see", "run"] as const;
export type SurfaceVerb = (typeof SURFACE_VERBS)[number];
export type SurfaceLine = { no?: true; verb: SurfaceVerb; address: string };
export type SurfaceAnswer = "yes" | "no" | undefined;

type Serves = { as: string; items?: string[]; line: number }[];
export type SurfaceNode = {
  address: string;
  sort: "utility" | "chain" | "link" | "lane" | "press" | "case";
  /** The name the package gave it: a utility's, a flow's, a stop's, a lane's, a press's word. */
  name: string;
  label?: string;
  /** What the package says it serves, where it says so itself; a node that says nothing takes its parent's. */
  serves?: Serves;
  /** The act a link's stamp, a lane's press or a case's press runs. */
  acts?: string[];
};

const ADDRESS = /^\/?[A-Za-z][\w-]*(\/[A-Za-z][\w-]*)*$/;

/** `see inventory`, `no run inventory/audit/containersAuditing` → a line. Refuses any other shape. */
export function readHold(text: string, line?: number): SurfaceLine {
  const words = text.trim().split(/\s+/);
  const no = words[0] === "no";
  if (no) words.shift();
  const [verb = "", address = "", ...rest] = words;
  if (!(SURFACE_VERBS as readonly string[]).includes(verb)) throw new CrubalError(`a held line says ${SURFACE_VERBS.join(" or ")}, with no before it or nothing: ${text.trim()}`, line);
  if (rest.length || !ADDRESS.test(address)) throw new CrubalError(`a held line names one address, names joined by /: ${text.trim()}`, line);
  return { ...(no ? { no: true as const } : {}), verb: verb as SurfaceVerb, address };
}

export const holdText = (l: SurfaceLine): string => `${l.no ? "no " : ""}${l.verb} ${l.address}`;

/** The address a utility's member stands at; a flow or a lane that names no utility stands under the place, `/name`. */
const under = (utility: string | undefined, name: string) => `${utility ?? ""}/${name}`;

/** A case press's name in an address: `yes`, `no`, or `or1`, `or2` in their order. */
const caseParts = (c: NonNullable<Flow["stops"][number]["cases"]>[number]) => [
  { key: "yes", press: c.yes },
  { key: "no", press: c.no },
  ...c.or.map((press, i) => ({ key: `or${i + 1}`, press })),
];

/**
 * Every node of the surface the packages in force declare, parents before children. A lane a chain names as a
 * stop is that chain's link, and stands as a lane of its own too, since it is worked on its own.
 */
export function surfaceOf(info: { utilities?: Utility[]; flows?: Flow[]; lanes?: Lane[] }): SurfaceNode[] {
  const out: SurfaceNode[] = [];
  const lanes = info.lanes ?? [];
  for (const u of info.utilities ?? []) out.push({ address: u.name, sort: "utility", name: u.name, ...(u.label ? { label: u.label } : {}), serves: u.serves });
  for (const f of info.flows ?? []) {
    const at = under(f.utility, f.name);
    out.push({ address: at, sort: "chain", name: f.name, ...(f.label ? { label: f.label } : {}), serves: f.serves });
    for (const s of f.stops) {
      const link = `${at}/${s.name}`;
      const lane = lanes.find((l) => l.name === s.name);
      out.push({ address: link, sort: "link", name: s.name, ...(lane?.label ? { label: lane.label } : {}), ...(s.act ? { acts: [s.act] } : {}) });
      for (const c of s.cases ?? []) {
        const name = c.kind === "stranger" ? "stranger" : (c.name ?? "flag");
        for (const { key, press } of caseParts(c))
          if (press.word) out.push({ address: `${link}/${name}/${key}`, sort: "case", name: key, label: press.word, acts: press.runs.map((r) => r.act) });
      }
    }
  }
  for (const l of lanes) {
    const at = under(l.utility, l.name);
    out.push({ address: at, sort: "lane", name: l.name, ...(l.label ? { label: l.label } : {}), serves: l.serves });
    for (const p of [l.card?.primary, l.card?.quiet, ...(l.card?.quick ?? [])])
      if (p && /^[A-Za-z][\w-]*$/.test(p.to) && p.to !== "page") out.push({ address: `${at}/${p.to}`, sort: "press", name: p.to, label: p.word, acts: [p.to] });
  }
  return out;
}

/** The addresses on the way to one, nearest last: `a/b/c` → `a`, `a/b`, `a/b/c`. */
export function addressPath(address: string): string[] {
  const lead = address.startsWith("/") ? "/" : "";
  const parts = address.slice(lead.length).split("/");
  return parts.map((_, i) => lead + parts.slice(0, i + 1).join("/"));
}

const decided = (lines: SurfaceLine[], verb: SurfaceVerb, address: string): SurfaceAnswer => {
  const path = addressPath(address);
  for (let i = path.length - 1; i >= 0; i--) {
    const here = lines.filter((l) => l.verb === verb && l.address === path[i]);
    if (here.length) return here.some((l) => l.no) ? "no" : "yes";
  }
  return undefined;
};

/**
 * What a set of lines says of one verb at one address (14.14): the deepest line on the way to it decides, a
 * no beats a yes at the same depth, and nothing said is no answer (the package's word stands). Running needs
 * seeing: where seeing is withheld, running is too, whatever a run line says.
 */
export function surfaceAnswer(lines: SurfaceLine[], verb: SurfaceVerb, address: string): SurfaceAnswer {
  if (verb === "run" && decided(lines, "see", address) === "no") return "no";
  return decided(lines, verb, address);
}
