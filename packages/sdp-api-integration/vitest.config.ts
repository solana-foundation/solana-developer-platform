import path from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../apps/sdp-api/src"),
      "@sdp/api": path.resolve(__dirname, "../../apps/sdp-api/src"),
      "@sdp/api-test": path.resolve(__dirname, "../../apps/sdp-api/src/test"),
    },
  },
  test: {
    globals: true,
    setupFiles: ["src/setup.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: {
          configPath: path.resolve(__dirname, "../../apps/sdp-api/wrangler.toml"),
        },
        miniflare: {
          bindings: {
            ENVIRONMENT: "development",
            API_VERSION: "v1",
            RUN_INTEGRATION_TESTS: "true",
            SOLANA_MOCK: "false",
            // Kora configuration - only set if explicitly configured
            // Local: KORA_RPC_URL=http://localhost:8080 pnpm test
            // CI: Set KORA_RPC_URL in workflow env
            ...(process.env.KORA_RPC_URL && {
              KORA_RPC_URL: process.env.KORA_RPC_URL,
              FEE_PAYMENT_PROVIDER: "kora",
            }),
          },
        },
      },
    },
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
