import type { Context } from "hono";
import type { DatabaseClient } from "@/db";
import { getDb } from "@/db";
import type { Env } from "@/types/env";
import { getAuth } from "./auth";
import { internalError } from "./errors";

export async function resolveCreatorUserId(c: Context<{ Bindings: Env }>): Promise<string> {
  const auth = getAuth(c);

  if (auth.userId) {
    return auth.userId;
  }

  if (!auth.apiKeyId) {
    throw internalError("Could not resolve creator user");
  }

  const creator = await getDb(c.env)
    .prepare(`SELECT created_by FROM api_keys WHERE id = ? AND organization_id = ?`)
    .bind(auth.apiKeyId, auth.organizationId)
    .first<{ created_by: string }>();

  if (!creator?.created_by) {
    throw internalError("Could not resolve creator user");
  }

  return creator.created_by;
}

/**
 * Rebuild a creation request's audit actor from its stored creator id:
 * `issued_tokens.created_by` (like `asset_profiles.created_by`) holds the
 * creating request's auth id — a `users.id` for dashboard requests, an
 * `api_keys.id` for API requests. A users-row lookup splits the two, so a
 * replayed audit write attributes the event to the original creator instead
 * of whichever credential happened to replay it.
 */
export async function resolveCreatorAuditActor(
  db: DatabaseClient,
  creatorId: string
): Promise<{ userId?: string; apiKeyId?: string }> {
  const user = await db
    .prepare("SELECT 1 AS present FROM users WHERE id = ?")
    .bind(creatorId)
    .first<{ present: number }>();
  return user ? { userId: creatorId } : { apiKeyId: creatorId };
}
