import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // silk-wasm ships its own .wasm next to the ESM entry and locates it through
  // `new URL('silk.wasm', import.meta.url)`. Dependency pre-bundling would move
  // that URL into .vite/deps and break the lookup, so keep it out of the bundle.
  optimizeDeps: {
    exclude: ["silk-wasm"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome110",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
