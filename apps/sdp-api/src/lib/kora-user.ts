import type { Context } from "hono";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/** Stable per-user id for Kora's `user_id` (session/clerk user, else API key id). */
export function resolveKoraUserId(c: AppContext): string | undefined {
  return c.get("session")?.userId ?? c.get("clerk")?.userId ?? c.get("apiKey")?.id;
}
