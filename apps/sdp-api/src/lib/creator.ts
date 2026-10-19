import type { Context } from "hono";
import type { Env } from "@/types/env";
import { getAuth } from "./auth";
import { internalError } from "./errors";

/**
 * The user a write is attributed to: the Clerk user, or for an API key the user
 * who created it, which authentication read from the key's live row. Adds no
 * statement of its own.
 */
export async function resolveCreatorUserId(c: Context<{ Bindings: Env }>): Promise<string> {
  const auth = getAuth(c);

  if (auth.userId) {
    return auth.userId;
  }

  const createdBy = c.get("keyCreator");
  if (!createdBy) {
    throw internalError("Could not resolve creator user");
  }

  return createdBy;
}
