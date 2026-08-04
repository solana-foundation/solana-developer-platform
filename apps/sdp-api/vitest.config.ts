import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Must precede the "@sdp/types" prefix alias: the generated file's
      // suffix does not match the export subpath.
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
    setupFiles: ["src/test/setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
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
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage/node",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/types/**", "src/db/migrations/**"],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
