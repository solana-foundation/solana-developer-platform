import {
  apiPort,
  describeEnvSource,
  exitOnStartupError,
  waitForDataStores,
  waitForService,
  watchServer,
  workerPort,
} from "./lib/dev-env.mjs";

// The local twin of sdp-infra's worker service: the same server with cron on.
// It skips migrations and waits for the API's port instead, which opens only
// after scripts/dev-api.mjs has migrated, so no tick runs on an old schema.
try {
  console.log(`Environment: ${describeEnvSource()}`);
  await waitForDataStores();
  await waitForService(
    "API",
    `http://127.0.0.1:${apiPort}`,
    Number(apiPort),
    "under `pnpm dev`, the API task starts it; otherwise run `pnpm -F @sdp/api dev`",
    // Covers migrations and a cold tsx boot, like Playwright's 180s webServer timeout.
    180
  );
  await watchServer({ port: workerPort, disableCron: "false" });
} catch (error) {
  exitOnStartupError(error);
}
