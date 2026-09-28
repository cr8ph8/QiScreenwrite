import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Local writer build. Deliberately free of the hosted app's Lovable plugins,
// MCP bundler and dev-server bridge: the output is served by local/server
// from 127.0.0.1 and must not depend on hosted tooling.
//
// In development, `vite --config vite.local.config.ts` proxies /api to a
// running local service (npm run local:serve). The proxy rewrites Origin and
// Host so the service's exact-origin checks hold for the dev tab.
const serviceOrigin = process.env.LOCAL_WRITER_ORIGIN ?? "http://127.0.0.1:4318";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  server: {
    host: "127.0.0.1",
    port: 5178,
    proxy: {
      "/api": { target: serviceOrigin, changeOrigin: true, headers: { Origin: serviceOrigin } },
    },
  },
  build: {
    outDir: "dist-local",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "local.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
