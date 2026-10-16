import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database } from "@lib/emc/db/client";
import * as schema from "@lib/emc/db/schema";

// in-memory postgres with the real drizzle/ migrations applied
export async function createTestDb(): Promise<{ db: Database; client: PGlite }> {
  const client = new PGlite();
  const pg = drizzle({ client, schema });
  await migrate(pg, { migrationsFolder: path.resolve(__dirname, "../../../drizzle") });
  return { db: pg as unknown as Database, client };
}
