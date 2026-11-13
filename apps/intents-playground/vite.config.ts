import { defineConfig } from "vite";

// The service and the surfnet run on their own ports. The dev server forwards `/api` to the service
// and `/rpc` to the surfnet, so the page needs no CORS. The browser's verifier reads only `/rpc`.
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
      "/rpc": {
        target: "http://127.0.0.1:8899",
        rewrite: (path) => path.replace(/^\/rpc/, ""),
      },
      "/adapter": {
        target: "http://127.0.0.1:8791",
        rewrite: (path) => path.replace(/^\/adapter/, ""),
      },
    },
  },
});
