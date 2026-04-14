import { env as providedEnv } from "cloudflare:workers";
import { getDb } from "@/db";
import type { Env } from "@/types/env";

export const env = {
  ...(providedEnv as Env),
  db: getDb(providedEnv as Env),
};
