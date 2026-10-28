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
  async redirects() {
    return [
      {
        source: "/dashboard/:projectId/markets/earn/:path*",
        destination: "/dashboard/:projectId/markets/embedded-yield/:path*",
        permanent: false,
      },
      {
        source: "/dashboard/markets/earn/:path*",
        destination: "/dashboard/markets/embedded-yield/:path*",
        permanent: false,
      },
    ];
  },
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
      // Agents look for llms.txt at the site root; the docs app's canonical copies
      // live under /docs/ai.
      {
        source: "/llms.txt",
        destination: `${docsProxyOrigin}/docs/ai/llms.txt`,
      },
      {
        source: "/llms-full.txt",
        destination: `${docsProxyOrigin}/docs/ai/llms-full.txt`,
      },
      {
        source: "/docs.md",
        destination: `${docsProxyOrigin}/docs.md`,
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
  async headers() {
    return [
      {
        // Baseline hardening for every route. nosniff and the referrer
        // default are safe universally; HSTS is ignored over plain HTTP, so
        // self-hosted plain-HTTP deployments are unaffected. The CSP closes
        // the two sinks no page here legitimately uses — a <base> tag and
        // plugin content (<object>/<embed>) — so a future injection on this
        // money-movement surface cannot use them to exfiltrate, while script,
        // style and connect sources stay as flexible as Next.js needs.
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "base-uri 'none'; object-src 'none'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
      {
        // Clickjacking protection where the money-movement actions live.
        // Scoped to the dashboard and the BFF: the public /pay/:token request
        // page stays embeddable for issuers. Next.js lets the last matching
        // rule for a header key win, so this repeats the baseline directives
        // instead of relying on the two policies combining, and adds
        // frame-ancestors (the modern directive, covering paths
        // X-Frame-Options misses); the legacy header stays for older clients.
        source: "/dashboard/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "base-uri 'none'; object-src 'none'; frame-ancestors 'self'",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "base-uri 'none'; object-src 'none'; frame-ancestors 'self'",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
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

const sentryDisabled =
  process.env.NEXT_PUBLIC_DISABLE_SENTRY === "1" || process.env.PLAYWRIGHT_DISABLE_SENTRY === "1";

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

  ...(sentryDisabled
    ? {}
    : {
        // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
        // This can increase your server load as well as your hosting bill.
        // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
        // side errors will fail.
        tunnelRoute: "/monitoring",
      }),

  // Automatically tree-shake Sentry logger statements to reduce bundle size.
  disableLogger: true,
});
