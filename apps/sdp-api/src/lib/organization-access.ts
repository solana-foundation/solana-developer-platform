import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { type ApiKeyLifecycleColumns, apiKeyRowRefusal } from "@/lib/api-key-rotation";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import type { Env } from "@/types/env";

/**
 * The one uncached organization read every authenticated request makes, and
 * what it decides (HOO-1955; APE-387, APE-564):
 *
 * - the organization is still `active` — a deleted or suspended organization
 *   stops authenticating on its next request, whatever a cache still says;
 * - for an API key, the key's own row is still usable (active, not expired,
 *   not past its rotation deadline), read in the same statement by primary key;
 * - the request's origin passes `settings.allowedIpAddresses`.
 *
 * Caches (the API-key KV entry, its reconciliation sweep) only make rejection
 * cheaper: they can never keep a revoked credential authenticated, because
 * this read runs on every request. Deliberately uncached for the same reason —
 * a cache would keep the previous answer for its TTL after a revocation or an
 * allowlist change.
 *
 * Returns the raw settings it read, so authentication records the
 * organization's entitlements from the same read (APE-351).
 */

/**
 * Returned as `unknown` on purpose: pre-validation values can be any shape,
 * and {@link isClientIpAllowed} already fails closed on anything unrecognized —
 * that decision belongs in one place.
 */
function readAllowedIpAddresses(settings: string | null): unknown {
  if (!settings) {
    return null;
  }

  const parsed = parsePostgresJson<{ allowedIpAddresses?: unknown } | null>(settings);
  return parsed?.allowedIpAddresses ?? null;
}

/**
 * Apply `settings.allowedIpAddresses` to the current request. Runs on every
 * authenticated path — a restriction only one of three doors honors is not a
 * restriction; an API key's own `allowedIps` intersects on top.
 *
 * A malformed restriction fails closed. The settings column is JSON the API
 * writes itself, so a blob that does not parse is a bug: it throws, and the
 * request fails loudly with a 500.
 */
function enforceIpAllowlist(c: Context<{ Bindings: Env }>, settings: string | null): void {
  if (!isClientIpAllowed(getClientIp(c), readAllowedIpAddresses(settings))) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed for this organization");
  }
}

/** The refusal a session-based door (Clerk) gives a non-active organization. */
export function organizationNotActive(): AppError {
  return new AppError("UNAUTHORIZED", "Organization is not active");
}

/**
 * Organization access for a session-based door (Clerk): the organization must
 * exist and be `active`, and the origin must pass its allowlist. Call it before
 * the door writes anything, so a refused request leaves no state behind.
 */
export async function enforceOrganizationAccess(
  c: Context<{ Bindings: Env }>,
  organizationId: string
): Promise<string | null> {
  const row = await getDb(c.env)
    .prepare("SELECT status, settings FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ status: string; settings: string | null }>();

  if (row?.status !== "active") {
    throw organizationNotActive();
  }
  enforceIpAllowlist(c, row.settings);
  return row.settings;
}

/**
 * Organization access for an API key, with the key's own live row in the same
 * statement: the organization must be `active` and the key's row, when there
 * is one, usable — whatever the cached entry says.
 *
 * A cached key with no row at all is let through on the organization's word.
 * The API never deletes a key row (revocation is a status), the cache-miss
 * path already refuses a key it cannot find, and the reconciliation sweep's
 * orphan pass tombstones such an entry within one tick.
 */
export async function enforceApiKeyOrganizationAccess(
  c: Context<{ Bindings: Env }>,
  organizationId: string,
  apiKeyId: string
): Promise<string | null> {
  const row = await getDb(c.env)
    .prepare(
      `SELECT o.status AS organization_status, o.settings,
              ak.status, ak.expires_at, ak.rotation_deadline
         FROM organizations o
         LEFT JOIN api_keys ak ON ak.id = ? AND ak.organization_id = o.id
        WHERE o.id = ?`
    )
    .bind(apiKeyId, organizationId)
    .first<
      { organization_status: string; settings: string | null } & (
        | ApiKeyLifecycleColumns
        | { status: null; expires_at: null; rotation_deadline: null }
      )
    >();

  if (row?.organization_status !== "active") {
    throw new AppError("REVOKED_API_KEY");
  }
  const refusal = row.status === null ? null : apiKeyRowRefusal(row);
  if (refusal === "revoked") {
    throw new AppError("REVOKED_API_KEY");
  }
  if (refusal === "expired") {
    throw new AppError("EXPIRED_API_KEY");
  }
  enforceIpAllowlist(c, row.settings);
  return row.settings;
}
