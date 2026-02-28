import { createMDX } from "fumadocs-mdx/next";

// We generate .source ourselves in scripts/dev.mjs and scripts/build; disable
// Fumadocs' auto-watcher to avoid runtime rewrites that break Next's parser.
process.env._FUMADOCS_MDX = "1";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default withMDX(nextConfig);
