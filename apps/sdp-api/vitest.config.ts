import path from "node:path";
import { defineConfig } from "vitest/config";
import { TEST_WORKER_COUNT } from "./src/test/worker-count";

const isShardedRun = process.env.TEST_SHARD !== undefined;
const isCiRun = process.env.CI !== undefined;

export default defineConfig({
  resolve: {
    alias: {
      // Must precede the "@sdp/types" prefix alias: the generated file's
      // suffix does not match the export subpath.
      "@sdp/types/generated/ramp": path.resolve(
        __dirname,
        "../../packages/sdp-types/src/generated/ramp.generated.ts"
      ),
      "@": path.resolve(__dirname, "./src"),
      "@sdp/types": path.resolve(__dirname, "../../packages/sdp-types/src"),
    },
  },
  test: {
    globals: true,
    globalSetup: ["src/test/node-global-setup.ts"],
    setupFiles: ["src/test/setup.ts"],
    maxWorkers: TEST_WORKER_COUNT,
    server: {
      deps: {
        inline: [
          /@solana\/mosaic-sdk/,
          /@solana\/kit/,
          /@solana\/signers/,
          /@solana\/pay/,
          /@solana\/subscriptions/,
        ],
      },
    },
    include: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/__tests__/**/*.unit.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage/node",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/types/**", "src/db/migrations/**"],
      // Per-shard runs exclude thresholds: each shard only sees a fraction of
      // the suite, so threshold enforcement happens once in the CI merge job
      // over the blob-merged coverage of all shards. The merge run leaves
      // TEST_SHARD unset, so it enforces the thresholds defined here.
      ...(isShardedRun
        ? {}
        : {
            thresholds: {
              statements: 78.1,
              branches: 68.7,
              functions: 84.3,
              lines: 78.5,
              autoUpdate: !isCiRun,
            },
          }),
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
