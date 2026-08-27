import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.devnet.test.ts"],
    environment: "node",
    // Prover round trips and Photon indexing dominate; a whole flow can take
    // minutes and retrying a half-finished money flow is worse than waiting.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
