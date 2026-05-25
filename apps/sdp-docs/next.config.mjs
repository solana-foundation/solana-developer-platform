import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

// Verified with fumadocs-mdx 14.3.1: this internal opt-out keeps Fumadocs from
// rewriting .source after our scripts patch it for Next's parser.
process.env._FUMADOCS_MDX = "1";

const withMDX = createMDX({
  configPath: "source.config.ts",
  outDir: ".source",
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  assetPrefix: "/docs",
};

// Gated so non-container builds skip the unused standalone tree.
// outputFileTracingRoot is required for pnpm-workspace symlinks to resolve.
if (process.env.NEXT_BUILD_STANDALONE === "1") {
  nextConfig.output = "standalone";
  nextConfig.outputFileTracingRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
}

export default withMDX(nextConfig);
