import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const LOCAL_ENV_PATH = path.resolve(__dirname, "../../apps/sdp-api/.env.local");

function loadEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const [key, ...rest] = trimmed.split("=");
    if (!key) {
      continue;
    }
    const raw = rest.join("=");
    const quoted = raw.match(/^(['"])(.*)\1$/);
    values[key] = quoted ? quoted[2] : raw;
  }
  return values;
}

for (const [key, value] of Object.entries(loadEnvFile(LOCAL_ENV_PATH))) {
  process.env[key] ??= value;
}

process.env.ENVIRONMENT ??= "development";
process.env.API_VERSION ??= "v1";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
process.env.RUN_INTEGRATION_TESTS = "true";
process.env.SOLANA_MOCK = "false";
process.env.API_KEY_PEPPER ??= "test-pepper-for-integration";
process.env.SOLANA_NETWORK ??= "devnet";
process.env.CUSTODY_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");

export default defineConfig({
  resolve: {
    alias: {
      // `@solana-program/token-2022`'s confidential-transfer helpers import
      // `@solana/zk-sdk/bundler`, while `@solana/mosaic-sdk/_zk` resolves to
      // `@solana/zk-sdk/node` under the `node` condition. Each entry point
      // instantiates its own copy of the wasm module, so an ElGamal keypair
      // built through one is rejected by the other with "expected instance of
      // ElGamalKeypair". `apps/sdp-api/scripts/build-node.mjs` already collapses
      // the two for the Docker bundle; tests need the same redirect or every
      // confidential-transfer operation fails at runtime.
      "@solana/zk-sdk/bundler": "@solana/zk-sdk/node",
      "@": path.resolve(__dirname, "../../apps/sdp-api/src"),
      "@sdp/api/test-support": path.resolve(
        __dirname,
        "../../apps/sdp-api/src/test/integration-support.ts"
      ),
    },
  },
  test: {
    globals: true,
    setupFiles: ["src/setup.ts"],
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    isolate: false,
    server: {
      deps: {
        // token-2022 and zk-sdk are inlined so the `@solana/zk-sdk/bundler`
        // alias above actually reaches them: an externalized dependency is
        // loaded by Node's own ESM resolver, which ignores vite aliases.
        inline: [/@solana\/mosaic-sdk/, /@solana-program\/token-2022/, /@solana\/zk-sdk/],
      },
    },
  },
});
