import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Must precede the "@sdp/types" prefix alias: the generated file's `.generated.ts`
      // suffix doesn't match the export subpath, so the prefix alias can't resolve it.
      "@sdp/types/generated/ramp-support": path.resolve(
        __dirname,
        "../../packages/sdp-types/src/generated/ramp-support.generated.ts"
      ),
      "@": path.resolve(__dirname, "./src"),
      "@sdp/types": path.resolve(__dirname, "../../packages/sdp-types/src"),
    },
  },
  test: {
    globals: true,
    globalSetup: ["src/test/node-global-setup.ts"],
    fileParallelism: false,
    isolate: false,
    maxWorkers: 1,
    include: ["src/**/*.node.test.ts"],
    exclude: ["node_modules", ".wrangler", "dist"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage/node",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/types/**", "src/db/migrations/**"],
    },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
