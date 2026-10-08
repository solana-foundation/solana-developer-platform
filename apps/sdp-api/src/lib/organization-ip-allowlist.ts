import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import type { Env } from "@/types/env";

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
 * Deliberately uncached (one primary-key read per request): a cache would keep
 * the previous origin authorized for its TTL after an operator turns this on.
 *
 * A malformed restriction fails closed. The settings column is JSON the API
 * writes itself, so a blob that does not parse is a bug: it throws, and the
 * request fails loudly with a 500.
 *
 * Returns the raw settings it read, so authentication records the
 * organization's entitlements from the same read (APE-351).
 */
export async function enforceOrganizationIpAllowlist(
  c: Context<{ Bindings: Env }>,
  organizationId: string
): Promise<string | null> {
  const row = await getDb(c.env)
    .prepare("SELECT settings FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ settings: string | null }>();

  if (!row) {
    // Organization gone: no restriction to read; the owning paths report that.
    return null;
  }

  const allowedIpAddresses = readAllowedIpAddresses(row.settings);
  if (!isClientIpAllowed(getClientIp(c), allowedIpAddresses)) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed for this organization");
  }
  return row.settings;
}
