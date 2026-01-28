import { env as providedEnv } from "cloudflare:test";
import type { Env } from "@/types/env";

export const env = providedEnv as Env;
