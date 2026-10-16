import { Pool } from "@neondatabase/serverless";
import { attachDatabasePool } from "@vercel/functions";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// driver-agnostic types: neon in prod, pglite in tests
export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Executor = Database | Tx;

let db: Database | undefined;

// lazy: importing this module never needs DATABASE_URL, only the first getDb() call does.
// neon-serverless (websocket Pool) rather than neon-http, because intake needs interactive transactions.
// the Pool needs a global WebSocket (Node 22+, pinned in package.json "engines"); no `ws` fallback.
// one pool per instance (Fluid compute reuses instances); attachDatabasePool releases idle clients
// before the instance suspends, so connections don't leak. it's a no-op outside Vercel.
export function getDb(): Database {
  if (db) return db;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var: DATABASE_URL");
  if (typeof globalThis.WebSocket === "undefined") {
    throw new Error("Neon Pool needs a global WebSocket — run on Node.js 22 or later");
  }
  const pool = new Pool({ connectionString: url });
  attachDatabasePool(pool);
  db = drizzle({ client: pool, schema });
  return db;
}
