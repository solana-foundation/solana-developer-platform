import type { Context } from "hono";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Resolve a stable per-end-user identifier to forward to Kora as `user_id` on
 * sign calls. Kora uses it to attribute per-user sponsorship/usage limits, and
 * requires it when its config has free pricing + usage tracking enabled (mainnet);
 * configs without usage tracking (e.g. devnet) ignore it.
 *
 * Preference order:
 *   1. SDP user id from a dashboard session or Clerk (`usr_…`) — the human end-user.
 *   2. API key id — for programmatic callers, attributes usage per integration key.
 *
 * Returns undefined when unauthenticated; the adapter then omits `user_id`.
 */
export function resolveKoraUserId(c: AppContext): string | undefined {
  return c.get("session")?.userId ?? c.get("clerk")?.userId ?? c.get("apiKey")?.id;
}
