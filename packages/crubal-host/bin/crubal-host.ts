#!/usr/bin/env node
// crubal-host: run the reference host over a Postgres store. CRUBAL_PG_URL names the database;
// CRUBAL_HOST_DOMAIN the host's domain; CRUBAL_HOST_KEY guards the loops.
//   crubal-host migrate                      the store's tables and the host's
//   crubal-host owner create <domain>        an owner, with the key the host signs its chain with
//   crubal-host key issue <owner> <caller>   an API key for a caller (printed once)
//   crubal-host serve [--port 8787]          the HTTP surface (CRUBAL_HOST_OF=domain=url,… maps publishers not yet at https://<domain>)

import { connect } from "@cruba/crubal-postgres";
import { Host } from "../src/host.ts";
import { serve } from "../src/server.ts";

const [cmd, a, b, c] = process.argv.slice(2);
const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

const pool = connect();
const host = new Host(pool, {
  domain: process.env.CRUBAL_HOST_DOMAIN ?? "localhost",
  ...(process.env.CRUBAL_HOST_KEY ? { hostKey: process.env.CRUBAL_HOST_KEY } : {}),
  ...(process.env.CRUBAL_HOST_CORS ? { cors: process.env.CRUBAL_HOST_CORS.split(",").map((s) => s.trim()) } : {}),
  ...(process.env.CRUBAL_HOST_BODY_LIMIT ? { bodyLimit: Number(process.env.CRUBAL_HOST_BODY_LIMIT) } : {}),
  // CRUBAL_HOST_OF maps a domain to where its host answers, for a gate run against a publisher that isn't
  // at https://<domain> yet: "cashierfu.com=http://localhost:3100/h,other.example=http://…".
  ...(process.env.CRUBAL_HOST_OF ? { hostOf: hostOfFrom(process.env.CRUBAL_HOST_OF) } : {}),
  fresh: "write",
});

function hostOfFrom(spec: string): (domain: string) => string {
  const map = new Map(spec.split(",").map((pair) => pair.trim()).filter(Boolean).map((pair) => { const i = pair.indexOf("="); return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] as [string, string]; }));
  return (domain: string) => map.get(domain) ?? `https://${domain}`;
}

try {
  if (cmd === "migrate") {
    await host.migrate();
    console.log("migrated");
  } else if (cmd === "owner" && a === "create" && b) {
    console.log(JSON.stringify(await host.createOwner(b)));
  } else if (cmd === "key" && a === "issue" && b && c) {
    console.log(await host.issueKey(b, c));
  } else if (cmd === "serve") {
    const port = Number(flag("--port") ?? 8787);
    serve(host).listen(port, () => console.log(`crubal-host on :${port}`));
  } else {
    console.log("usage: crubal-host migrate | owner create <domain> | key issue <owner> <caller> | serve [--port 8787]");
    process.exit(2);
  }
} finally {
  if (cmd !== "serve") await pool.end();
}
