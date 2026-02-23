import path from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@sdp/keychain-coinbase": path.resolve(__dirname, "../../packages/sdp-keychain-coinbase/src"),
      "@sdp/keychain-para": path.resolve(__dirname, "../../packages/sdp-keychain-para/src"),
      "@sdp/types": path.resolve(__dirname, "../../packages/sdp-types/src"),
    },
  },
  test: {
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: {
          configPath: "./wrangler.toml",
        },
        miniflare: {
          bindings: {
            ENVIRONMENT: "development",
            API_VERSION: "v1",
            API_KEY_PEPPER: "test-pepper-for-unit-tests",
            SOLANA_MOCK: "true",
            RUN_INTEGRATION_TESTS: "false",
          },
        },
      },
    },
    include: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/__tests__/**/*.unit.ts"],
    exclude: ["node_modules", ".wrangler", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/types/**", "src/db/migrations/**"],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
