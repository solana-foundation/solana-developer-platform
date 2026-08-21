import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";

const { getDb } = apiTestSupport;

function readEnvFromProcess(): ApiTestEnv {
  const proc: Record<string, string | undefined> = { ...process.env };
  proc.DATABASE_URL = proc.TEST_DATABASE_URL;
  if (proc.SDP_INTEGRATION_CUSTODY_PROVIDER === "local" && !proc.SDP_DEPLOYMENT_MODE) {
    proc.SDP_DEPLOYMENT_MODE = "self_hosted";
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
