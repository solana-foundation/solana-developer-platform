// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import { sentryDataCollection, sentryScrubbingHooks } from "@sdp/redaction/sentry";
import * as Sentry from "@sentry/nextjs";

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

    // What the SDK may collect on its own: nothing.
    dataCollection: sentryDataCollection,

    // The scrubbing boundary. `dataCollection` only stops the SDK collecting
    // PII on its own; these hooks strip what the app attaches, on every
    // payload type — errors, spans, logs, metrics, breadcrumbs. Shared with
    // the API so there is one denylist.
    ...sentryScrubbingHooks,
  });
}
