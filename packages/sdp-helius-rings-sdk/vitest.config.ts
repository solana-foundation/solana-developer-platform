import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Setting `exclude` replaces Vitest's defaults rather than adding to them,
    // hence the spread. The devnet gate spends real funds and is never part of
    // an ordinary run.
    exclude: [...defaultExclude, "src/**/*.devnet.test.ts"],
    environment: "node",
  },
});
