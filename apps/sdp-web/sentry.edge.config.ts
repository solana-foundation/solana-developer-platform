// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import { sentryScrubbingHooks } from "@sdp/redaction";
import * as Sentry from "@sentry/nextjs";
import { sentryDataCollection } from "./src/lib/sentry-data-collection";

const sentryDsn =
  process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_DISABLE_SENTRY === "1"
    ? undefined
    : process.env.NEXT_PUBLIC_SENTRY_DSN;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV,

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1,

    dataCollection: sentryDataCollection,
    // Keep transaction and span scrubbing on the pre-v11 trace lifecycle.
    traceLifecycle: "static",

    // The scrubbing boundary — see the note in sentry.server.config.ts.
    ...sentryScrubbingHooks,
    beforeSendSpan: Sentry.withStaticSpan(sentryScrubbingHooks.beforeSendSpan),
  });
}
