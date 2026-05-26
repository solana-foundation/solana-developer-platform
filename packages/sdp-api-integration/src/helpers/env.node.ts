import { getDb } from "@sdp/api/db";
import type { Env } from "@sdp/api/types/env";

function readEnvFromProcess(): Env {
  const proc: Record<string, string | undefined> = { ...process.env };
  proc.DATABASE_URL = proc.TEST_DATABASE_URL ?? proc.DATABASE_URL;
  proc.SDP_RUNTIME = "node";
  return proc as unknown as Env;
}

const providedEnv = readEnvFromProcess();

if (!providedEnv.DATABASE_URL) {
  throw new Error("env requires DATABASE_URL or TEST_DATABASE_URL to be set.");
}

export const env = {
  ...providedEnv,
  db: getDb(providedEnv),
};
