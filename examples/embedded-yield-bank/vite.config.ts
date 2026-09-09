import path from "node:path";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4174",
    },
  },
  preview: {
    proxy: {
      "/api": "http://127.0.0.1:4174",
    },
  },
});
