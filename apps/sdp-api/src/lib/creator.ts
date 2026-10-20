import type { Context } from "hono";
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
