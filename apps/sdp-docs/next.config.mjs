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

export default withMDX(nextConfig);
