import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

// 3031 is pinned, and strictPort makes a taken port an error rather than a
// quiet move to 3032: the review link has to be the one written down.
export default defineConfig({
  server: { port: 3031, strictPort: true },
  preview: { port: 3031, strictPort: true },
  plugins: [
    // Prerendered to plain HTML: the page has nothing to compute per request,
    // so what gets published is a folder of static files, not a Node server.
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
    }),
    react(),
  ],
});
