import { defineConfig } from "vite";

// The service runs on its own port. The dev server forwards `/api` to it, so the page needs no CORS.
// Vite's esbuild compiles the JSX, so the app needs no React plugin.
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  esbuild: { jsx: "automatic" },
  server: {
    port: 5178,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/adapter": {
        target: "http://127.0.0.1:8791",
        rewrite: (path) => path.replace(/^\/adapter/, ""),
      },
    },
  },
});
