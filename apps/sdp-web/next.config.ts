import { withSentryConfig } from "@sentry/nextjs";
import createWithVercelToolbar from "@vercel/toolbar/plugins/next";
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

const withVercelToolbar = createWithVercelToolbar();

export default withVercelToolbar(
  withSentryConfig(nextConfig, {
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

    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Automatically tree-shake Sentry logger statements to reduce bundle size.
    disableLogger: true,
  })
);
