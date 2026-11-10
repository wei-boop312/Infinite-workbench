import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { createLocalStudioMiddleware } from "../api/src/localStudio";

export default defineConfig({
  plugins: [react(), {
    name: "local-studio-mock-api",
    configureServer(server) {
      const directory = process.env.CANVAS_STUDIO_STATE_DIR ?? resolve(server.config.root, "../../work/local-studio-state");
      const studio = createLocalStudioMiddleware(directory);
      server.middlewares.use(studio);
      server.httpServer?.once("close", studio.close);
    },
  }],
});
