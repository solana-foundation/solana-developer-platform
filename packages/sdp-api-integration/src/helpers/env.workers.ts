import { env as providedEnv } from "cloudflare:workers";
import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";

const { getDb } = apiTestSupport;

export const env = {
  ...(providedEnv as ApiTestEnv),
  db: getDb(providedEnv as ApiTestEnv),
};
