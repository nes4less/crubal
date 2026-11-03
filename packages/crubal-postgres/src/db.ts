// db.ts: connecting, the schema, and a schema per test so cases never see each other.

import { readFileSync } from "node:fs";
import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/**
 * A pool for a connection string, or the `CRUBAL_PG_URL` environment variable. With a schema (the argument,
 * or `CRUBAL_PG_SCHEMA`), every connection is pinned to it: on a shared database such as a Supabase
 * project the store and host tables live in their own schema, never in `public`, which the database's own
 * API serves to its anonymous role.
 */
export function connect(
  url = process.env.CRUBAL_PG_URL,
  schema = process.env.CRUBAL_PG_SCHEMA,
  /** `max` and `idleMs` size the pool (`CRUBAL_PG_POOL_MAX`, `CRUBAL_PG_IDLE_MS`): a serverless host runs many
   * instances, each with its own pool, against one pooler's limit (2026-11-03: 600 reached 73 times in three
   * hours), so each keeps few connections and lets idle ones go soon. */
  o: { statementTimeoutMs?: number; max?: number; idleMs?: number } = {},
): Pool {
  if (!url) throw new Error("no Postgres URL: pass one or set CRUBAL_PG_URL");
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`a schema is a lower-case word: ${schema}`);
  // A statement timeout (the argument, or `CRUBAL_PG_STATEMENT_TIMEOUT` in milliseconds) rides the same way:
  // one statement that runs away fails alone instead of holding a connection for everyone (2026-10-26).
  const env = process.env.CRUBAL_PG_STATEMENT_TIMEOUT;
  const timeout = o.statementTimeoutMs ?? (env ? Number(env) : undefined);
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) throw new Error(`a statement timeout is a count of milliseconds: ${timeout}`);
  // The schema rides as a startup parameter, which Postgres and the Supabase session pooler both honour; a
  // query on each connection's open would race the first statement (pg warns, and will refuse).
  const options = [...(schema ? [`-c search_path=${schema}`] : []), ...(timeout ? [`-c statement_timeout=${timeout}`] : [])].join(" ");
  const num = (v: string | undefined) => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const max = o.max ?? num(process.env.CRUBAL_PG_POOL_MAX);
  const idle = o.idleMs ?? num(process.env.CRUBAL_PG_IDLE_MS);
  return new pg.Pool({ connectionString: url, ...(options ? { options } : {}), ...(max ? { max } : {}), ...(idle ? { idleTimeoutMillis: idle } : {}) });
}

/** Create or update the store's tables in the current search path. Idempotent. */
export async function migrate(client: Client): Promise<void> {
  await client.query(SCHEMA_SQL);
}

/** Run `fn` inside one transaction, committing on return and rolling back on a throw. */
export async function transaction<T>(pool: Pool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * A fresh schema for one test: created, migrated, made the pool's search path, and dropped by the
 * returned function. Every connection of the pool is pinned to it, so a test's store is its own.
 */
export async function testSchema(pool: Pool, name = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`): Promise<() => Promise<void>> {
  await pool.query(`create schema "${name}"`);
  pool.on("connect", (c) => void c.query(`set search_path to "${name}"`));
  const client = await pool.connect();
  try {
    await client.query(`set search_path to "${name}"`);
    await migrate(client);
  } finally {
    client.release();
  }
  return async () => {
    await pool.query(`drop schema "${name}" cascade`);
  };
}
