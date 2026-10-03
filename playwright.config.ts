import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const chromePath = process.env.PLAYWRIGHT_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: { executablePath: chromePath },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    env: { CANVAS_STUDIO_STATE_DIR: resolve("test-results", `local-studio-state-${Date.now()}`) },
    timeout: 30_000,
  },
});
