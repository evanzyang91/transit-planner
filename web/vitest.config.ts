import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the "~/*" -> "./src/*" mapping in tsconfig.json. Vitest does
      // not read tsconfig paths on its own.
      "~": src,
      // `server-only` throws by design when imported outside a Next server
      // bundle. Tests import these modules directly, so it's stubbed inert.
      "server-only": `${src}/test/server-only-stub.ts`,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // env.js validates the full server schema at import time; tests only need
      // the modules, not a real environment.
      SKIP_ENV_VALIDATION: "true",
      ANTHROPIC_API_KEY: "test-key-not-used",
      // The Supabase client is constructed at module scope, so importing
      // server modules needs these present. No test makes a real request.
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_KEY: "test-key-not-used",
    },
  },
});
