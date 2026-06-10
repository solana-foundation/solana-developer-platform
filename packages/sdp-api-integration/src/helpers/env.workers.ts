import { env as providedEnv } from "cloudflare:workers";
import { getDb } from "@sdp/api/db";
import type { Env } from "@sdp/api/types/env";

export const env = {
  ...(providedEnv as Env),
  db: getDb(providedEnv as Env),
};
