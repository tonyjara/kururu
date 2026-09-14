import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * In dev the UI is served by vite and the data comes from the kururu server on
 * 7717; the proxy below puts both on one origin so the WebSocket is same-origin
 * and there is no CORS anywhere. In production the kururu server serves the
 * built assets itself, so this config does not apply and the paths are already
 * relative — the app never needs to know which of the two it is running under.
 */
const SERVER = `http://127.0.0.1:${process.env.KURURU_PORT ?? 7717}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The phone reaches the vite dev server over the tailnet too.
    host: "0.0.0.0",
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": { target: SERVER, changeOrigin: true },
      "/ws": { target: SERVER, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
