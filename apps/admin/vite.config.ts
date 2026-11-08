// GTM-agents: build configuration for the operator dashboard. The build lands in the worker's
// public/admin folder, which the Worker serves at /admin through the ASSETS binding.
import { defineConfig } from "vite";

export default defineConfig({
  base: "/admin/",
  build: {
    outDir: "../worker/public/admin",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    proxy: {
      "/health": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
