import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    environment: "node",
    // Bound local CPU/SQLite/native-decoder contention; retain the original
    // default hook/test and production deadlines, without retries.
    maxWorkers: 4,
  },
});
