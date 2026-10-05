import type { init } from "@sentry/nextjs";

// Sentry 11 enables automatic sensitive-data collection by default. Keep the
// previous privacy boundary explicit; scrubbing hooks still filter app data.
export const sentryDataCollection: NonNullable<Parameters<typeof init>[0]["dataCollection"]> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};
