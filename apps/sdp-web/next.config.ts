import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const docsProxyOrigin = (
  process.env.SDP_DOCS_PROXY_ORIGIN?.trim() ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:3001"
    : "https://docs.platform.solana.com")
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  distDir: process.env.PLAYWRIGHT_NEXT_DIST_DIR?.trim() || ".next",
  async rewrites() {
    return [
      {
        source: "/postman/collection.json",
        destination: `${docsProxyOrigin}/docs/postman/collection.json`,
      },
      {
        source: "/provider-onboarding/:path*",
        destination: `${docsProxyOrigin}/provider-onboarding/:path*`,
      },
      {
        source: "/docs",
        destination: `${docsProxyOrigin}/docs`,
      },
      {
        source: "/docs/:path*",
        destination: `${docsProxyOrigin}/docs/:path*`,
      },
    ];
  },
};

// Standalone output ships a minimal node_modules + server.js for the slim
// Docker runtime (HOO-513). Gated on NEXT_BUILD_STANDALONE so Vercel,
// Playwright, and local `next build` runs don't generate an unused
// .next/standalone tree. The Dockerfile sets the env in the builder stage.
// outputFileTracingRoot walks file tracing up to the monorepo root so
// workspace deps (@sdp/types, patches) are bundled — without it standalone
// misses pnpm-workspace symlinks.
if (process.env.NEXT_BUILD_STANDALONE === "1") {
  nextConfig.output = "standalone";
  nextConfig.outputFileTracingRoot = path.resolve(import.meta.dirname, "../..");
}

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "solana-fndn",

  project: "sdp-web",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  // Automatically tree-shake Sentry logger statements to reduce bundle size.
  disableLogger: true,
});
