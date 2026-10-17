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
export function connect(url = process.env.CRUBAL_PG_URL, schema = process.env.CRUBAL_PG_SCHEMA): Pool {
  if (!url) throw new Error("no Postgres URL: pass one or set CRUBAL_PG_URL");
  const pool = new pg.Pool({ connectionString: url });
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`a schema is a lower-case word: ${schema}`);
    pool.on("connect", (c) => void c.query(`set search_path to "${schema}"`));
  }
  return pool;
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
