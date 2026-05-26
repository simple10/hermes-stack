import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/test/**/*.test.ts"],
    // No globals; tests import { test, expect } from "vitest" explicitly.
    pool: "forks",
  },
});
