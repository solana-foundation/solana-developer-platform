/**
 * Vitest config for Node-runtime tests (HOO-510).
 *
 * Sibling of `vitest.config.ts` (Cloudflare Workers pool). Some code paths
 * require real Node APIs that Workers don't expose — notably `ioredis`, which
 * opens raw TCP sockets via `node:net`. Tests targeting those paths live in
 * `**\/*.node.test.ts` files and run here in plain Node, isolated from the CF
 * pool so neither config has to dance around the other's restrictions.
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
