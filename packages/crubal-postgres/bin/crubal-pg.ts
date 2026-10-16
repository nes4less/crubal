#!/usr/bin/env node
// crubal-pg: operate a CRUBAL store on Postgres (docs/design/store.md). CRUBAL_PG_URL names the database.
//   crubal-pg migrate                               create or update the tables
//   crubal-pg rebuild <owner>                       empty the owner's state tables and apply the log again
//   crubal-pg verify <owner> [--keys <file>]        check the chain's links and signatures
//   crubal-pg export <owner>                        the owner's log, as JSON
//   crubal-pg redact <owner> <log> [<write>]        redact one write (by index) or the whole entry
//   crubal-pg erase <owner> <record>                redact every value write to a record
//   crubal-pg dry-run <owner> <bundle.json>         what installing the version would restamp, without writing
//   crubal-pg drain <owner> [--rate N]              apply pending instructions to at most N records (default 100)
//   crubal-pg project <owner> --defs <file>...      publish every view's stale rows
//   crubal-pg tick <owner> <contract> --now <moment> --defs <file>...   run a scheduled contract's due ticks

import { readFileSync } from "node:fs";
import { emptyDictionary, readDefinitions } from "../../crubal/src/defs.ts";
import { readContracts } from "../../crubal/src/store.ts";
import { readViews } from "../../crubal/src/views.ts";
import { readAccess } from "../../crubal/src/access.ts";
import { PgBorder } from "../src/border.ts";
import { connect, migrate, transaction } from "../src/db.ts";
import { PgStore } from "../src/store.ts";

const [cmd, owner, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.flatMap((a, i) => (a === name ? [rest[i + 1] as string] : []));
const flags = (name: string) => {
  const out: string[] = [];
  let on = false;
  for (const a of rest) {
    if (a.startsWith("--")) on = a === name;
    else if (on) out.push(a);
  }
  return out;
};

function definitions() {
  const dict = emptyDictionary();
  const texts = flags("--defs").map((f) => readFileSync(f, "utf8"));
  for (const t of texts) readDefinitions(t, dict);
  const all = texts.join("\n");
  const views = readViews(all);
  const { perms } = readAccess(all);
  return { dict, views, perms, contracts: readContracts(all) };
}

async function main(): Promise<number> {
  const pool = connect();
  try {
    if (cmd === "migrate") {
      await transaction(pool, (c) => migrate(c));
      console.log("migrated");
      return 0;
    }
    if (!owner) return usage();
    if (cmd === "rebuild") {
      const state = await new PgStore(pool, owner).rebuild();
      console.log(`rebuilt ${owner}: ${state.records.size} records`);
      return 0;
    }
    if (cmd === "verify") {
      const keysFile = flag("--keys")[0];
      const keys = keysFile ? (JSON.parse(readFileSync(keysFile, "utf8")).keys ?? JSON.parse(readFileSync(keysFile, "utf8"))) : undefined;
      const v = await new PgStore(pool, owner).verify(keys);
      console.log(JSON.stringify(v));
      return v.valid ? 0 : 1;
    }
    if (cmd === "export") {
      console.log(JSON.stringify(await new PgStore(pool, owner).entries(), null, 2));
      return 0;
    }
    if (cmd === "redact" && rest[0]) {
      await new PgStore(pool, owner).redact(rest[0], rest[1] !== undefined && !rest[1].startsWith("--") ? Number(rest[1]) : undefined);
      console.log(`redacted ${rest[0]}${rest[1] ? ` write ${rest[1]}` : ""}`);
      return 0;
    }
    if (cmd === "drain") {
      const r = await new PgStore(pool, owner).drain(Number(flag("--rate")[0] ?? 100));
      console.log(`drained ${owner}: ${r.applied.length} records, ${r.remaining} still waiting`);
      return 0;
    }
    if (cmd === "dry-run" && rest[0]) {
      const bundle = JSON.parse(readFileSync(rest[0], "utf8"));
      console.log(JSON.stringify(await new PgStore(pool, owner).dryRun(bundle), null, 2));
      return 0;
    }
    if (cmd === "erase" && rest[0]) {
      const r = await new PgStore(pool, owner).erase(rest[0]);
      console.log(`erased ${rest[0]}: ${r.redacted} writes redacted${r.witnessed.length ? `; witnessed entries left as they are: ${r.witnessed.join(", ")}` : ""}`);
      return 0;
    }
    if (cmd === "project") {
      const d = definitions();
      const entries = await new PgStore(pool, owner, { projecting: { dict: d.dict, views: d.views, perms: d.perms } }).project();
      console.log(`published ${entries.length} entries`);
      return 0;
    }
    if (cmd === "tick" && rest[0]) {
      const d = definitions();
      const now = flag("--now")[0] ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const store = new PgStore(pool, owner, { projecting: { dict: d.dict, views: d.views, perms: d.perms } });
      const r = await new PgBorder(store, { dict: d.dict, contracts: d.contracts, perms: d.perms }).tick(rest[0], now);
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    return usage();
  } finally {
    await pool.end();
  }
}

function usage(): number {
  console.log("usage: crubal-pg migrate | rebuild <owner> | verify <owner> [--keys <file>] | export <owner> | redact <owner> <log> [<write>] | erase <owner> <record> | dry-run <owner> <bundle.json> | drain <owner> [--rate N] | project <owner> --defs <file>... | tick <owner> <contract> --now <moment> --defs <file>...");
  return 2;
}

process.exit(await main());
