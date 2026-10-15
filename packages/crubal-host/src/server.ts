// server.ts: the HTTP surface (docs/design/host.md). Owner-scoped, small, the same for every owner; the host
// resolves the caller first and hands the store only the caller ID; every decision after that is the
// store's access. Nothing here decides anything a package could say.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Access } from "../../crubal/src/access.ts";
import { formOf } from "../../crubal/src/forms.ts";
import type { Json, JsonObject } from "../../crubal/src/model.ts";
import type { Caller, Host } from "./host.ts";

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
    const parts = url.pathname.split("/").filter(Boolean);
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const method = req.method ?? "GET";

    if (url.pathname === "/.well-known/crubal.json") return json(res, 200, await host.wellKnown());

    // The loops, for a scheduler, behind the host key.
    if (parts[0] === "project" || parts[0] === "tick") {
      if (method !== "POST") throw new HttpError(405, "POST");
      if (host.o.hostKey && req.headers["x-host-key"] !== host.o.hostKey) throw new HttpError(403, "the host key");
      const b = (await body(req)) || "{}";
      const o = JSON.parse(b) as JsonObject;
      if (parts[0] === "project") return json(res, 200, await host.project(typeof o.owner === "string" ? o.owner : undefined));
      return json(res, 200, await host.tick(typeof o.now === "string" ? o.now : undefined, typeof o.owner === "string" ? o.owner : undefined));
    }

    if (parts[0] !== "o" || !parts[1]) throw new HttpError(404, "not found");
    const owner = decodeURIComponent(parts[1]);
    const who: Caller | null = await host.whoIs(req.headers.authorization);
    const callerId = who && who.owner === owner ? who.caller : undefined;
    const isOwner = callerId === owner;
    const store = await host.storeFor(owner);
    const at = host.now();
    const [, , what, name, ...rest] = parts;

    if (what === "run" && name && method === "POST") {
      const b = JSON.parse((await body(req)) || "{}") as JsonObject;
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
      const payload = await body(req);
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
        const b = JSON.parse((await body(req)) || "{}") as { cursor?: { [view: string]: number } };
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
      const b = JSON.parse((await body(req)) || "{}") as JsonObject;
      const entry = await store.commitFrom(() => ({ by: { person: callerId }, extra: [{ review: { ...it, decision: b.decision ?? b, by: callerId } }], out: null }), at);
      return json(res, 200, { decided: Number(name), entry: entry.entry ? String(entry.entry.log) : "" });
    }
    if (what === "install" && method === "POST") {
      if (!isOwner) throw new HttpError(403, "the owner installs");
      const b = JSON.parse(await body(req)) as JsonObject;
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
      const status = e instanceof HttpError ? e.status : 400;
      json(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });
}
