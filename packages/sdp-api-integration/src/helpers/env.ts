import { env as providedEnv } from "cloudflare:test";
import type { Env } from "@sdp/api/types/env";

export const env = providedEnv as Env;
