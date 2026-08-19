import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import { getLogger } from "@/runtime/logger";
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
 * A malformed restriction fails closed, but an unparseable settings blob reads
 * as no restriction: it expresses no configuration, every other reader treats
 * it that way, and denying would lock the organization out of the API and
 * dashboard over a row nobody can repair through the API. Inducing that state
 * needs DB write access — which could clear the allowlist outright anyway.
 */
export async function enforceOrganizationIpAllowlist(
  c: Context<{ Bindings: Env }>,
  organizationId: string
): Promise<void> {
  const row = await getDb(c.env)
    .prepare("SELECT settings FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ settings: string | null }>();

  if (!row) {
    // Organization gone: no restriction to read; the owning paths report that.
    return;
  }

  let allowedIpAddresses: unknown;
  try {
    allowedIpAddresses = readAllowedIpAddresses(row.settings);
  } catch (error) {
    // Corruption we want to hear about; no restriction, per the doc above.
    getLogger().error(
      { error, organizationId },
      "Organization settings could not be parsed; no IP allowlist could be read"
    );
    return;
  }

  if (!isClientIpAllowed(getClientIp(c), allowedIpAddresses)) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed for this organization");
  }
}
