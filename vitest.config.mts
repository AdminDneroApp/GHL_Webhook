import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // mirrors tsconfig "paths"
    alias: { "@lib": path.resolve(import.meta.dirname, "lib") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // lib/env.ts requires these at import time; placeholders only — tests never call GHL or Neon
    env: {
      GHL_C2_API_KEY: "test-key",
      GHL_C2_PIPELINE_NAME: "test-pipeline",
      GHL_C2_LOCATION_ID: "loc-test",
      GHL_BASE_URL: "https://ghl.invalid",
    },
  },
});
