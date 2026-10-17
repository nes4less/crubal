// server.ts: the HTTP surface (docs/design/host.md). Owner-scoped, small, the same for every owner; the host
// resolves the caller first and hands the store only the caller ID; every decision after that is the
// store's access. Nothing here decides anything a package could say.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Access } from "@cruba/crubal";
import { formOf } from "@cruba/crubal";
import { type Json, type JsonObject, parseJson } from "@cruba/crubal";
import type { Caller, Host } from "./host.ts";
import { endEmergencyEdge, type EmergencyRequest, logEmergencyRead, makeEmergencyEdge } from "./emergency.ts";
import { Index } from "./indexer.ts";
import { readTerms, robotsTxt, termsHeaders, termsJson } from "./terms.ts";

/**
 * A request as the host sees it, whatever carried it: the node server below, or a route in an app that runs
 * the host in process. `url` is the path and query as node gives it; the origin a signature covers comes
 * from the `host` and `x-forwarded-proto` headers; the body is already read, once, so a digest can cover it.
 */
export type HostRequest = { method: string; url: string; headers: { [h: string]: string | string[] | undefined }; body: string };
/** What a request's log line and CORS need, set as the request is understood. */
export type Seen = { owner?: string; caller?: string; route?: string };
export type HostReply = { status: number; headers: { [h: string]: string }; body: string; seen: Seen };

/** The reply as it is built: the few verbs the handler uses, kept in memory and handed to whatever transport asked. */
class Reply {
  status = 200;
  headers: { [h: string]: string } = {};
  body = "";
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  writeHead(status: number, headers?: { [h: string]: string }) {
    this.status = status;
    if (headers) Object.assign(this.headers, headers);
  }
  end(chunk?: string) {
    if (chunk !== undefined) this.body = chunk;
  }
}
type Req = HostRequest;
type Res = Reply;

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

/** Read a node request's body, refusing one over the limit before anything else reads it. */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, `the body is over ${limit} bytes`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Compare a presented secret with the kept one in constant time, so a guess learns nothing from the clock. */
function sameSecret(presented: string | undefined, kept: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(kept, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Answer one request. Every route is here, owner-scoped, the same for every owner; errors become a JSON
 * body with their status. Transports call this: `serve` for node, an app's route for in-process hosting.
 */
export async function handle(host: Host, req: HostRequest): Promise<HostReply> {
  const res = new Reply();
  const seen: Seen = {};
  try {
    await respond(host, req, res, seen);
  } catch (e: unknown) {
    const status = e instanceof HttpError ? e.status : typeof (e as { status?: number }).status === "number" ? (e as { status: number }).status : 400;
    json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
  return { status: res.status, headers: res.headers, body: res.body, seen };
}

async function respond(host: Host, req: Req, res: Res, seen: Seen): Promise<void> {
  {
    const url = new URL(req.url ?? "/", "http://host");
    const method = req.method ?? "GET";
    // Browsers: the allowlisted origin gets its headers; a preflight is answered here.
    const origin = req.headers.origin;
    if (typeof origin === "string" && host.o.cors?.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-headers", "authorization, content-type, signature, signature-input, content-digest, date, x-host-key");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("vary", "origin");
    }
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // The body was read once, up front: a signed request's digest covers it. The limit holds here too.
    const raw = req.body;
    if (Buffer.byteLength(raw, "utf8") > (host.o.bodyLimit ?? 1_048_576)) throw new HttpError(413, `the body is over ${host.o.bodyLimit ?? 1_048_576} bytes`);
    const bodyOf = () => raw;
    const parts = url.pathname.split("/").filter(Boolean);
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    /** One header's value; a repeated header gives its first value. */
    const header = (k: string): string | undefined => {
      const v = req.headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    seen.route = parts.slice(0, 3).join("/");

    if (url.pathname === "/health" && method === "GET") {
      const h = await host.health();
      return json(res, h.ok ? 200 : 503, h);
    }
    if (url.pathname === "/.well-known/crubal.json") return json(res, 200, await host.wellKnown());
    // Published packages (11.5, 11.7): /packages/<owner>/<name>/<version>/package.json, and the text beside it.
    if (parts[0] === "packages" && parts.length === 5 && method === "GET") {
      const [, owner, name, version, file] = parts as [string, string, string, string, string];
      const p = await host.publishedBundle(decodeURIComponent(owner), decodeURIComponent(name), decodeURIComponent(version));
      if (!p) throw new HttpError(404, `no published ${owner}/${name} /${version}`);
      if (file === "package.json") {
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
        return json(res, 200, p.bundle);
      }
      if (file === "package.crubal") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" });
        return res.end(p.text);
      }
      throw new HttpError(404, "package.json or package.crubal");
    }
    // OAuth's return leg: the code becomes the connection the state names.
    if (url.pathname === "/oauth/callback" && method === "GET") {
      const state = JSON.parse(Buffer.from(q("state") ?? "", "base64url").toString("utf8") || "{}") as { owner?: string; name?: string };
      const provider = state.name ? host.o.oauth?.[state.name] : undefined;
      if (!state.owner || !state.name || !provider || !q("code")) throw new HttpError(400, "state, name and code");
      const c = await host.credentials.exchangeCode(state.owner, state.name, q("code") as string, provider, []);
      return json(res, 200, c as unknown as Json);
    }

    // The loops, for a scheduler, behind the host key.
    const hostKeyOk = !host.o.hostKey || sameSecret(header("x-host-key"), host.o.hostKey);
    if (parts[0] === "project" || parts[0] === "tick" || parts[0] === "retry" || parts[0] === "push" || parts[0] === "expire" || parts[0] === "drain") {
      if (method !== "POST") throw new HttpError(405, "POST");
      if (!hostKeyOk) throw new HttpError(403, "the host key");
      const o = parseJson(bodyOf() || "{}") as JsonObject;
      const owner = typeof o.owner === "string" ? o.owner : undefined;
      const now = typeof o.now === "string" ? o.now : undefined;
      if (parts[0] === "project") return json(res, 200, await host.project(owner, now));
      if (parts[0] === "drain") return json(res, 200, await host.drain(typeof o.rate === "number" ? o.rate : 100, owner, now));
      if (parts[0] === "retry") return json(res, 200, await host.retry(now, owner));
      if (parts[0] === "push") return json(res, 200, await host.push(now, owner));
      if (parts[0] === "expire") return json(res, 200, await host.expire(now, owner));
      return json(res, 200, await host.tick(now, owner));
    }

    // The platform index (14.8, 14.10): who the caller is to every owner on this host, and the rows they
    // stand in a relation to. A bearer token only; the host vouches, so no owner's signature is involved.
    if (parts[0] === "whoami" && method === "GET") {
      const me = await host.whoIs(header("authorization"));
      if (!me) throw new HttpError(401, "sign in");
      seen.caller = `${me.owner}:${me.caller}`;
      if (parts[1] === "rows") {
        const relation = q("relation");
        if (!relation) throw new HttpError(400, "relation");
        return json(res, 200, { caller: me.caller, home: me.owner, relation, rows: await host.rowsFor(me, relation, { ...(q("view") ? { view: q("view") as string } : {}), ...(q("limit") ? { limit: Number(q("limit")) } : {}) }) });
      }
      return json(res, 200, await host.whoami(me));
    }

    if (parts[0] !== "o" || !parts[1]) throw new HttpError(404, "not found");
    const owner = decodeURIComponent(parts[1]);
    // A signed request from another owner (RFC 9421) names its signer; a bearer token names a caller.
    const target = `${header("x-forwarded-proto") ?? "http"}://${header("host") ?? "host"}${req.url ?? "/"}`;
    const who: Caller | null = req.headers.signature ? await host.whoSigned(owner, { method, url: target, body: raw, headers: req.headers }) : await host.whoIs(header("authorization"));
    // A hosted person (14.1) is the owner `domain:id`: the person signed in to the domain as that caller.
    // At another owner on this host they are `person:<domain:id>`, vouched for without a signature (14.8).
    const hostedAt = owner.indexOf(":");
    const domain = hostedAt > 0 ? owner.slice(0, hostedAt) : owner;
    const hostedId = hostedAt > 0 ? owner.slice(hostedAt + 1) : undefined;
    const callerId = await host.callerFor(owner, who);
    const isOwner = callerId === owner;
    seen.owner = owner;
    seen.caller = callerId;
    const store = await host.storeFor(owner);
    const at = host.now();
    const [, , what, name, ...rest] = parts;

    // Acting for a person (14.9): a system's request carries `for`; the person must have allowed it.
    const forPerson = (b: JsonObject) => (typeof b.for === "string" ? b.for : q("for"))?.replace(/^person:/, "");
    const acting = async (b: JsonObject) => {
      const person = forPerson(b);
      if (!person) return undefined;
      if (!who || who.via !== "key") throw new HttpError(403, "only a system with its own key acts for a person");
      const allowed = await host.mayActFor(who, person, at);
      if (!allowed) throw new HttpError(403, `${person} hasn't let ${who.owner}:${who.caller} act for them`);
      // The person as this owner sees them: at home their bare ID, elsewhere person:<domain:id>.
      const pAt = person.indexOf(":");
      const actor = pAt > 0 && person.slice(0, pAt) === owner ? person.slice(pAt + 1) : `person:${person}`;
      return { actor, acting: { system: `${who.owner}:${who.caller}`, person: actor, ...(allowed.items.length ? { items: allowed.items } : {}), gated: allowed.gated } };
    };

    // What a person allows (14.9): their own chain's owner lists, allows and revokes.
    if (what === "acting-for") {
      if (!isOwner || !hostedId) throw new HttpError(403, "the person allows who acts for them");
      if (method === "GET") return json(res, 200, { person: owner, allowed: (await host.actingFor(owner)) as unknown as Json });
      if (method === "POST") {
        const b = parseJson(bodyOf() || "{}") as { system?: string; items?: string[]; until?: string; gated?: boolean };
        const sysAt = (b.system ?? "").indexOf(":");
        if (!b.system || sysAt <= 0) throw new HttpError(400, "system, as <owner>:<id>");
        return json(res, 200, (await host.allowActing(owner, b.system.slice(0, sysAt), b.system.slice(sysAt + 1), { ...(b.items ? { items: b.items } : {}), ...(b.until ? { until: b.until } : {}), ...(b.gated !== undefined ? { gated: b.gated } : {}) })) as unknown as Json);
      }
      if (method === "DELETE" && name) return json(res, 200, { revoked: await host.revokeActing(owner, Number(name)) });
    }

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
        const b = parseJson(bodyOf() || "{}") as { scheme?: string; material?: JsonObject; scopes?: string[]; expires?: string };
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
      const r = parseJson(bodyOf() || "{}") as EmergencyRequest;
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
      for (const [k, val] of url.searchParams) if (!["page", "q", "shape"].includes(k)) picks[k] = val.split(",").map((x) => x.trim()).filter(Boolean);
      const page = await index.serve(store, name, { ...(q("page") ? { page: Number(q("page")) } : {}), ...(Object.keys(picks).length ? { picks } : {}), ...(q("q") ? { q: q("q") as string } : {}), ...(q("shape") ? { shape: q("shape") as string } : {}), ...(callerId ? { caller: callerId } : {}) });
      const th = termsHeaders(readTerms((await store.definitions()).info.terms));
      const robots = [page.indexable ? "all" : "noindex", ...(th["x-robots-tag"] ? th["x-robots-tag"].split(", ") : [])].filter((t, i, a) => a.indexOf(t) === i && !(t === "all" && a.includes("noindex")));
      res.setHeader("x-robots-tag", robots.join(", "));
      res.setHeader("x-crubal-terms", th["x-crubal-terms"] as string);
      res.setHeader("x-crubal-seq", String(page.seq));
      return json(res, 200, page as unknown as Json);
    }
    if (what === "run" && name && method === "POST") {
      const b = parseJson(bodyOf() || "{}") as JsonObject;
      const border = await host.borderFor(owner, store);
      const c = border.contracts.get(name);
      if (!c) throw new HttpError(404, `no contract ${name}`);
      const record = typeof b.record === "string" ? b.record : undefined;
      // A system acting for a person needs no standing of its own here (14.9); anyone else signs in.
      const acted = await acting(b);
      if (!acted && !callerId && !isOwner) throw new HttpError(401, "sign in");
      const actor = acted?.actor ?? callerId;
      if (acted) border.acting = acted.acting;
      // A form run is the person's answers landing as the contract says; a send acts.
      if (c.kind === "form") {
        if (!record) {
          const level = typeof b.level === "string" ? b.level : "product";
          return json(res, 200, await border.arrive(name, JSON.stringify(b.answers ?? {}), level, actor, undefined, at));
        }
        return json(res, 200, await border.receive(name, record, JSON.stringify(b.answers ?? {}), actor, at));
      }
      if (!record) throw new HttpError(400, "record");
      return json(res, 200, await border.send(name, record, actor, at));
    }
    if (what === "receive" && name && method === "POST") {
      const border = await host.borderFor(owner, store);
      if (!border.contracts.has(name)) throw new HttpError(404, `no contract ${name}`);
      const payload = bodyOf();
      const record = q("record");
      const run = q("run");
      const acted = await acting({});
      const actor = acted?.actor ?? callerId;
      if (acted) border.acting = acted.acting;
      if (record) return json(res, 200, await border.receive(name, record, payload, actor, at, run));
      return json(res, 200, await border.arrive(name, payload, q("level") ?? "product", actor, q("of"), at, q("within")));
    }
    if (what === "records" && name && method === "GET") {
      if (!callerId) throw new HttpError(401, "sign in");
      const r = await store.get(name);
      if (!r) throw new HttpError(404, `no record ${name}`);
      if (underEmergency && callerId) await logEmergencyRead(store, callerId, name, String(underEmergency.edge), at);
      const p = await store.definitions();
      // What the caller may see (14.6): with a permission menu declared, a facet needs the caller's `see` item.
      const state = p.perms.menu.size ? await store.state() : undefined;
      const access = state ? new Access(p.dict, p.perms, state.records, [...state.edges.values()] as never[], owner) : undefined;
      if (access) access.views = p.views;
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
      if (access) access.views = p.views;
      return json(res, 200, formOf(c, record, p.dict, { records: state.records, ...(callerId ? { caller: callerId } : {}), ...(access ? { access } : {}) }));
    }
    if (what === "stream" && name) {
      const border = await host.borderFor(owner, store);
      if (method === "GET") {
        const cursor = q("cursor") ? Object.fromEntries((q("cursor") as string).split(",").map((p) => p.split("=")).map(([v, n]) => [v ?? "", Number(n)])) : undefined;
        return json(res, 200, await border.streamRun(name, callerId, cursor, at));
      }
      if (rest[0] === "ack" && method === "POST") {
        const b = parseJson(bodyOf() || "{}") as { cursor?: { [view: string]: number } };
        return json(res, 200, await border.ack(name, b.cursor ?? {}));
      }
    }
    // Offers (7.8): what this owner shares, to whom `to` says; a take fetches one; a link is minted by the owner.
    if (what === "offer" && method === "GET") {
      const border = await host.borderFor(owner, store);
      const offers = [...border.contracts.values()].filter((c) => c.kind === "offer");
      if (!name) {
        const list: JsonObject[] = [];
        for (const c of offers) if (await host.mayTake(owner, c, callerId, q("link"))) list.push({ contract: c.name, gives: [...c.gives], mode: c.mode ?? "gathered", terms: { ...c.terms }, to: c.to ?? "private" });
        return json(res, 200, { owner, offers: list });
      }
      const c = border.contracts.get(name);
      if (!c || c.kind !== "offer") throw new HttpError(404, `no offer ${name}`);
      if (!(await host.mayTake(owner, c, callerId, q("link")))) throw new HttpError(callerId ? 403 : 401, `${name} isn't offered to you`);
      return json(res, 200, (await border.offer(name)) as unknown as Json);
    }
    if (what === "offer" && name && rest[0] === "link" && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner publishes a link");
      return json(res, 200, { contract: name, link: await host.offerLink(owner, name) });
    }
    if (what === "offer" && name && rest[0] === "unpublish" && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner unpublishes");
      await host.unpublishOffer(owner, name);
      return json(res, 200, { contract: name, unpublished: true });
    }
    if (what === "take" && name && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner takes");
      return json(res, 200, await host.take(owner, name, at));
    }
    // A presenter pushing a stream (12.6.2): the signed party's entries land in the index under its name.
    if (what === "inbox" && name && method === "POST") {
      if (!callerId || !/:owner$/.test(callerId)) throw new HttpError(401, "a signed request from the presenter");
      const presenter = callerId.replace(/:owner$/, "");
      const b = parseJson(bodyOf() || "{}") as { entries?: { [view: string]: JsonObject[] } };
      const index = new Index(host.pool);
      const cursor: JsonObject = {};
      for (const [view, list] of Object.entries(b.entries ?? {})) {
        const first = list[0];
        const [vname, version = ""] = String(first?.projection ?? view).split(" /");
        cursor[view] = await index.ingest(presenter, vname ?? view, version, String(first?.audience ?? "public"), list as unknown as never[]);
      }
      return json(res, 200, { contract: name, from: presenter, cursor });
    }
    // The review queue (9.5): open items by key; a decision is one entry, then the affected intakes replay.
    if (what === "review" && method === "GET") {
      if (!callerId) throw new HttpError(401, "sign in");
      const byKey: JsonObject = {};
      for (const it of await store.review()) {
        const key = String(it.key ?? "?");
        const list = (byKey[key] as JsonObject[] | undefined) ?? [];
        list.push(it);
        byKey[key] = list;
      }
      return json(res, 200, byKey);
    }
    if (what === "review" && method === "POST") {
      if (!callerId) throw new HttpError(401, "sign in");
      const d = parseJson(bodyOf() || "{}") as JsonObject;
      if (typeof d.key !== "string" || typeof d.decision !== "string") throw new HttpError(400, "a decision names its key and decision");
      if (d.key.startsWith("run:")) {
        const border = await host.borderFor(owner, store);
        return json(res, 200, await border.decideRun(String(d.run), d.decision === "drop" ? "drop" : "retry", callerId, at));
      }
      const r = await store.decide(d as { key: string; decision: string } & JsonObject, { person: callerId }, at);
      return json(res, 200, { decided: d.key, entry: r.entry ? String(r.entry.log) : "", replayed: r.replayed });
    }
    if (what === "install" && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner installs");
      const b = parseJson(bodyOf()) as JsonObject;
      // A bundle in the body, or a package by name fetched from its publisher's well-known file.
      if (typeof b.package === "string" && !b.facets && !b.hash) return json(res, 200, { installed: await host.installFrom(owner, b.package, typeof b.version === "string" ? b.version : undefined) });
      return json(res, 200, await host.install(owner, isObj(b.bundle) ? b.bundle : b));
    }
    if (what === "export" && method === "GET") {
      if (!isOwner) throw new HttpError(403, "the owner exports");
      const intake = (await store.pool.query("select json from intake where owner = $1 order by received", [owner])).rows.map((r: { json: Json }) => r.json);
      return json(res, 200, { owner, log: (await store.entries()) as unknown as Json, intake });
    }
    if (what === "erase" && name && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner erases");
      if (hostedId) {
        // A person erases their own records: the writes in their chain, and the domain's state follows.
        const domainStore = await host.storeFor(domain);
        const r = (await domainStore.state()).records.get(name);
        if (!r || r.owner !== owner) throw new HttpError(403, `${name} isn't ${owner}'s`);
        return json(res, 200, (await domainStore.erase(name)) as unknown as Json);
      }
      return json(res, 200, (await store.erase(name)) as unknown as Json);
    }
    if (what === "rotate" && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner rotates its key");
      return json(res, 200, (await host.rotateKey(owner, at)) as unknown as Json);
    }
    throw new HttpError(404, "not found");
  }
}

/** One structured line per request, when it has been answered. */
export function logLine(host: Host, req: { method: string; url: string }, reply: HostReply, started: number): void {
  if (host.o.log === false) return;
  const line: JsonObject = { at: host.now(), method: req.method, route: reply.seen.route ?? req.url, status: reply.status, ms: Date.now() - started, ...(reply.seen.owner ? { owner: reply.seen.owner } : {}), ...(reply.seen.caller ? { caller: reply.seen.caller } : {}) };
  if (host.o.log) host.o.log(line);
  else console.log(JSON.stringify(line));
}

/** The node server: reads each request, hands it to `handle`, writes the reply, logs the line. */
export function serve(host: Host): Server {
  return createServer((req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const done = (reply: HostReply) => {
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
      logLine(host, { method, url }, reply, started);
    };
    readBody(req, host.o.bodyLimit ?? 1_048_576)
      .then((body) => handle(host, { method, url, headers: req.headers, body }))
      .then(done)
      .catch((e: unknown) => {
        const status = e instanceof HttpError ? e.status : 400;
        done({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: `${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n`, seen: {} });
      });
  });
}
