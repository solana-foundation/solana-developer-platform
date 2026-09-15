import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";

const { getDb } = apiTestSupport;

function readEnvFromProcess(): ApiTestEnv {
  const proc: Record<string, string | undefined> = { ...process.env };
  proc.DATABASE_URL = proc.TEST_DATABASE_URL;
  if (proc.SDP_INTEGRATION_CUSTODY_PROVIDER === "local" && !proc.SDP_DEPLOYMENT_MODE) {
    proc.SDP_DEPLOYMENT_MODE = "self_hosted";
  }
  // A deploy without an issuer-supplied uri mints the SDP-hosted metadata URL,
  // which now comes only from PUBLIC_API_ORIGIN and fails closed when unset
  // (HOO-1013). The value is arbitrary against a local surfpool, so default it
  // for integration runs while still exercising the hosted-metadata path.
  if (!proc.PUBLIC_API_ORIGIN) {
    proc.PUBLIC_API_ORIGIN = "http://localhost:8787";
  }
  return proc as unknown as ApiTestEnv;
}

const providedEnv = readEnvFromProcess();

if (!providedEnv.DATABASE_URL) {
  throw new Error("env requires TEST_DATABASE_URL to be set.");
}

export const env = {
  ...providedEnv,
  db: getDb(providedEnv),
};
