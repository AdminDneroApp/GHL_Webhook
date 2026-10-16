import { defineConfig } from "drizzle-kit";

// generate needs no database; migrate reads DATABASE_URL (use the unpooled Neon url for migrations)
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/emc/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "" },
  strict: true,
  verbose: true,
});
