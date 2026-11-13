import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { defineConfig, type Plugin } from "vite";

const DEFINITIONS = resolve(new URL("../../intents/definitions", import.meta.url).pathname);

/// Serves `intents/definitions` at `/definitions`, so the Implementation tab shows an implementation as it is
/// written. A path that leaves the folder is refused.
function definitions(): Plugin {
  return {
    name: "definitions",
    configureServer(server) {
      server.middlewares.use("/definitions", (request, response) => {
        const path = resolve(DEFINITIONS, `.${decodeURIComponent(request.url ?? "")}`);

        if (!path.startsWith(DEFINITIONS + sep) || !path.endsWith(".json")) {
          response.statusCode = 404;
          response.end();
          return;
        }

        readFile(path, "utf8").then(
          (text) => {
            response.setHeader("content-type", "application/json");
            response.end(text);
          },
          () => {
            response.statusCode = 404;
            response.end();
          }
        );
      });
    },
  };
}

// The service runs on its own port. The dev server forwards `/api` to it, so the page needs no CORS.
// Vite's esbuild compiles the JSX, so the app needs no React plugin.
export default defineConfig({
  plugins: [definitions()],
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
