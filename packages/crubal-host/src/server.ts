// server.ts: the HTTP surface (docs/design/host.md). Owner-scoped, small, the same for every owner; the host
// resolves the caller first and hands the store only the caller ID; every decision after that is the
// store's access. Nothing here decides anything a package could say.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Access } from "../../crubal/src/access.ts";
import { formOf } from "../../crubal/src/forms.ts";
import type { Json, JsonObject } from "../../crubal/src/model.ts";
import type { Caller, Host } from "./host.ts";
import { endEmergencyEdge, type EmergencyRequest, logEmergencyRead, makeEmergencyEdge } from "./emergency.ts";
import { Index } from "./indexer.ts";
import { readTerms, robotsTxt, termsHeaders, termsJson } from "./terms.ts";

type Req = IncomingMessage;
type Res = ServerResponse;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (res: Res, status: number, body: Json) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
};

async function body(req: Req): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export function serve(host: Host): Server {
  const handle = async (req: Req, res: Res) => {
    const url = new URL(req.url ?? "/", "http://host");
    // The body is read once, up front: a signed request's digest covers it.
    const raw = await body(req);
    const bodyOf = () => raw;
    const parts = url.pathname.split("/").filter(Boolean);
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const method = req.method ?? "GET";

    if (url.pathname === "/.well-known/crubal.json") return json(res, 200, await host.wellKnown());
    // OAuth's return leg: the code becomes the connection the state names.
    if (url.pathname === "/oauth/callback" && method === "GET") {
      const state = JSON.parse(Buffer.from(q("state") ?? "", "base64url").toString("utf8") || "{}") as { owner?: string; name?: string };
      const provider = state.name ? host.o.oauth?.[state.name] : undefined;
      if (!state.owner || !state.name || !provider || !q("code")) throw new HttpError(400, "state, name and code");
      const c = await host.credentials.exchangeCode(state.owner, state.name, q("code") as string, provider, []);
      return json(res, 200, c as unknown as Json);
    }

    // The loops, for a scheduler, behind the host key.
    const hostKeyOk = !host.o.hostKey || req.headers["x-host-key"] === host.o.hostKey;
    if (parts[0] === "project" || parts[0] === "tick" || parts[0] === "retry") {
      if (method !== "POST") throw new HttpError(405, "POST");
      if (!hostKeyOk) throw new HttpError(403, "the host key");
      const o = JSON.parse(bodyOf() || "{}") as JsonObject;
      const owner = typeof o.owner === "string" ? o.owner : undefined;
      const now = typeof o.now === "string" ? o.now : undefined;
      if (parts[0] === "project") return json(res, 200, await host.project(owner));
      if (parts[0] === "retry") return json(res, 200, await host.retry(now, owner));
      return json(res, 200, await host.tick(now, owner));
    }

    if (parts[0] !== "o" || !parts[1]) throw new HttpError(404, "not found");
    const owner = decodeURIComponent(parts[1]);
    // A signed request from another owner (RFC 9421) names its signer; a bearer token names a caller.
    const target = `${(req.headers["x-forwarded-proto"] as string | undefined) ?? "http"}://${req.headers.host ?? "host"}${req.url ?? "/"}`;
    const who: Caller | null = req.headers.signature ? await host.whoSigned(owner, { method, url: target, body: raw, headers: req.headers }) : await host.whoIs(req.headers.authorization);
    const callerId = who && who.owner === owner ? who.caller : undefined;
    const isOwner = callerId === owner;
    const store = await host.storeFor(owner);
    const at = host.now();
    const [, , what, name, ...rest] = parts;

    // Terms (12.5.1): robots rules and the terms file, from the owner's package.
    if (what === "robots.txt" && method === "GET") {
      const terms = readTerms((await store.definitions()).info.terms);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(robotsTxt(terms, `/o/${owner}/`));
    }
    if (what === "terms.json" && method === "GET") return json(res, 200, termsJson(owner, readTerms((await store.definitions()).info.terms)) as unknown as Json);

    // Connections (docs/design/host.md, "Outbound"): the fact of a credential, never its material.
    if (what === "connections" && method === "GET") {
      if (!isOwner) throw new HttpError(403, "the owner's connections");
      return json(res, 200, (await host.credentials.connections(owner)) as unknown as Json);
    }
    if (what === "connect" && name) {
      if (!isOwner) throw new HttpError(403, "the owner connects");
      const provider = host.o.oauth?.[name];
      if (method === "GET") {
        if (!provider) throw new HttpError(404, `no OAuth provider for ${name}`);
        const scopes = (q("scope") ?? "").split(" ").filter(Boolean);
        return json(res, 200, { url: host.credentials.authorizeUrl(owner, name, provider, scopes) });
      }
      if (method === "POST") {
        const b = JSON.parse(bodyOf() || "{}") as { scheme?: string; material?: JsonObject; scopes?: string[]; expires?: string };
        if (!b.scheme || !b.material) throw new HttpError(400, "scheme and material");
        return json(res, 200, (await host.credentials.connect(owner, name, b.scheme, b.material, b.scopes ?? [], b.expires)) as unknown as Json);
      }
      if (method === "DELETE") {
        await host.credentials.disconnect(owner, name);
        return json(res, 200, { disconnected: name });
      }
    }

    // Emergency access (14.13): made by the platform under its terms; ended by the owner unless legal.
    if (what === "emergency" && method === "POST" && !name) {
      if (!hostKeyOk) throw new HttpError(403, "the platform makes emergency edges");
      const r = JSON.parse(bodyOf() || "{}") as EmergencyRequest;
      const made = await makeEmergencyEdge(store, r, host.o.emergency, at);
      await host.notice(owner, { emergency: r.edge, kind: r.kind, reference: r.reference, who: r.who, until: r.until });
      return json(res, 200, made as unknown as Json);
    }
    if (what === "emergency" && name && rest[0] === "end" && method === "POST") {
      if (!isOwner && !hostKeyOk) throw new HttpError(403, "the owner or the platform");
      return json(res, 200, (await endEmergencyEdge(store, name, callerId ?? "platform", at, isOwner)) as unknown as Json);
    }
    // A read under an emergency edge is logged, record by record (14.13).
    const underEmergency = callerId ? [...(await store.state()).edges.values()].find((e) => e.who === callerId && e.relation === "emergency" && (typeof e.until !== "string" || e.until > at)) : undefined;

    // A view's page from the reference index (12.6.1): applied from the stream first, then served.
    if (what === "v" && name && method === "GET") {
      const index = new Index(host.pool);
      await index.apply(store, name);
      const picks: { [filter: string]: string[] } = {};
      for (const [k, val] of url.searchParams) if (!["page", "q"].includes(k)) picks[k] = val.split(",").map((x) => x.trim()).filter(Boolean);
      const page = await index.serve(store, name, { ...(q("page") ? { page: Number(q("page")) } : {}), ...(Object.keys(picks).length ? { picks } : {}), ...(q("q") ? { q: q("q") as string } : {}), ...(callerId ? { caller: callerId } : {}) });
      const th = termsHeaders(readTerms((await store.definitions()).info.terms));
      const robots = [page.indexable ? "all" : "noindex", ...(th["x-robots-tag"] ? th["x-robots-tag"].split(", ") : [])].filter((t, i, a) => a.indexOf(t) === i && !(t === "all" && a.includes("noindex")));
      res.setHeader("x-robots-tag", robots.join(", "));
      res.setHeader("x-crubal-terms", th["x-crubal-terms"] as string);
      res.setHeader("x-crubal-seq", String(page.seq));
      return json(res, 200, page as unknown as Json);
    }
    if (what === "run" && name && method === "POST") {
      const b = JSON.parse(bodyOf() || "{}") as JsonObject;
      const border = await host.borderFor(owner, store);
      const c = border.contracts.get(name);
      if (!c) throw new HttpError(404, `no contract ${name}`);
      const record = typeof b.record === "string" ? b.record : undefined;
      if (!callerId && !isOwner) throw new HttpError(401, "sign in");
      // A form run is the person's answers landing as the contract says; a send acts.
      if (c.kind === "form") {
        if (!record) {
          const level = typeof b.level === "string" ? b.level : "product";
          return json(res, 200, await border.arrive(name, JSON.stringify(b.answers ?? {}), level, callerId, undefined, at));
        }
        return json(res, 200, await border.receive(name, record, JSON.stringify(b.answers ?? {}), callerId, at));
      }
      if (!record) throw new HttpError(400, "record");
      return json(res, 200, await border.send(name, record, callerId, at));
    }
    if (what === "receive" && name && method === "POST") {
      const border = await host.borderFor(owner, store);
      if (!border.contracts.has(name)) throw new HttpError(404, `no contract ${name}`);
      const payload = bodyOf();
      const record = q("record");
      const run = q("run");
      if (record) return json(res, 200, await border.receive(name, record, payload, callerId, at, run));
      return json(res, 200, await border.arrive(name, payload, q("level") ?? "product", callerId, q("of"), at));
    }
    if (what === "records" && name && method === "GET") {
      if (!callerId) throw new HttpError(401, "sign in");
      const state = await store.state();
      const r = state.records.get(name);
      if (!r) throw new HttpError(404, `no record ${name}`);
      if (underEmergency && callerId) await logEmergencyRead(store, callerId, name, String(underEmergency.edge), at);
      const p = await store.definitions();
      // What the caller may see (14.6): with a permission menu declared, a facet needs the caller's `see` item.
      const access = p.perms.menu.size ? new Access(p.dict, p.perms, state.records, [...state.edges.values()] as never[], owner) : undefined;
      const values: JsonObject = {};
      for (const [k, v] of Object.entries(r.values)) if (!access || isOwner || access.may(callerId, "see", k, r.id)) values[k] = v;
      const { sources, ...plain } = r as unknown as JsonObject;
      return json(res, 200, q("full") ? { ...plain, values, sources: sources ?? {} } : { ...plain, values });
    }
    if (what === "forms" && name && method === "GET") {
      const border = await host.borderFor(owner, store);
      const c = border.contracts.get(name);
      if (!c || c.kind !== "form") throw new HttpError(404, `no form ${name}`);
      const state = await store.state();
      const p = await store.definitions();
      const record = q("record") ? state.records.get(q("record") as string) : undefined;
      const access = p.perms.menu.size ? new Access(p.dict, p.perms, state.records, [...state.edges.values()] as never[], owner) : undefined;
      return json(res, 200, formOf(c, record, p.dict, { records: state.records, ...(callerId ? { caller: callerId } : {}), ...(access ? { access } : {}) }));
    }
    if (what === "stream" && name) {
      const border = await host.borderFor(owner, store);
      if (method === "GET") {
        const cursor = q("cursor") ? Object.fromEntries((q("cursor") as string).split(",").map((p) => p.split("=")).map(([v, n]) => [v ?? "", Number(n)])) : undefined;
        return json(res, 200, await border.streamRun(name, callerId, cursor, at));
      }
      if (rest[0] === "ack" && method === "POST") {
        const b = JSON.parse(bodyOf() || "{}") as { cursor?: { [view: string]: number } };
        return json(res, 200, await border.ack(name, b.cursor ?? {}));
      }
    }
    if (what === "review" && method === "GET") {
      if (!callerId) throw new HttpError(401, "sign in");
      const items = (await store.state()).reviews;
      const byKey: JsonObject = {};
      items.forEach((it, i) => {
        const key = String(it.key ?? it.address ?? "?");
        const list = (byKey[key] as JsonObject[] | undefined) ?? [];
        list.push({ item: i, ...it });
        byKey[key] = list;
      });
      return json(res, 200, byKey);
    }
    if (what === "review" && name && method === "POST") {
      if (!callerId) throw new HttpError(401, "sign in");
      const items = (await store.state()).reviews;
      const it = items[Number(name)];
      if (!it) throw new HttpError(404, `no review item ${name}`);
      const b = JSON.parse(bodyOf() || "{}") as JsonObject;
      const entry = await store.commitFrom(() => ({ by: { person: callerId }, extra: [{ review: { ...it, decision: b.decision ?? b, by: callerId } }], out: null }), at);
      return json(res, 200, { decided: Number(name), entry: entry.entry ? String(entry.entry.log) : "" });
    }
    if (what === "install" && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner installs");
      const b = JSON.parse(bodyOf()) as JsonObject;
      return json(res, 200, await host.install(owner, isObj(b.bundle) ? b.bundle : b));
    }
    if (what === "export" && method === "GET") {
      if (!isOwner) throw new HttpError(403, "the owner exports");
      const intake = (await store.pool.query("select json from intake where owner = $1 order by received", [owner])).rows.map((r: { json: Json }) => r.json);
      return json(res, 200, { owner, log: (await store.entries()) as unknown as Json, intake });
    }
    if (what === "erase" && name && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner erases");
      return json(res, 200, (await store.erase(name)) as unknown as Json);
    }
    throw new HttpError(404, "not found");
  };

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : typeof (e as { status?: number }).status === "number" ? ((e as { status: number }).status) : 400;
      json(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });
}
