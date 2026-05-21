/**
 * Vitest config for Node-runtime tests. Sibling of vitest.config.ts (CF
 * Workers pool). Tests in `**\/*.node.test.ts` run here in plain Node
 * because they need APIs Workers don't expose (e.g. ioredis → node:net).
 */

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@sdp/types": path.resolve(__dirname, "../../packages/sdp-types/src"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.node.test.ts"],
    exclude: ["node_modules", ".wrangler", "dist"],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
