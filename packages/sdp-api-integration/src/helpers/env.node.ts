import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";

const { getDb } = apiTestSupport;

function readEnvFromProcess(): ApiTestEnv {
  const proc: Record<string, string | undefined> = { ...process.env };
  if (!proc.TEST_DATABASE_URL) {
    throw new Error("Integration tests require TEST_DATABASE_URL.");
  }
  proc.DATABASE_URL = proc.TEST_DATABASE_URL;
  proc.SDP_RUNTIME = "node";
  return proc as unknown as ApiTestEnv;
}

const providedEnv = readEnvFromProcess();

export const env = {
  ...providedEnv,
  db: getDb(providedEnv),
};
