import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

/**
 * The organization-wide allowed-IP restriction, or null when there is none.
 *
 * Returned as `unknown` on purpose: a value that was persisted before this
 * setting was validated can be any shape at all, and {@link isClientIpAllowed}
 * already fails closed on everything it does not recognize. Narrowing it here
 * would mean deciding what a malformed restriction means, which is exactly the
 * decision that belongs in one place.
 */
function readAllowedIpAddresses(settings: string | null): unknown {
  if (!settings) {
    return null;
  }

  const parsed = parsePostgresJson<{ allowedIpAddresses?: unknown } | null>(settings);
  return parsed?.allowedIpAddresses ?? null;
}

/**
 * Apply an organization's `settings.allowedIpAddresses` to the current request.
 *
 * This runs on every authenticated path — API key, Clerk and session — because
 * the setting restricts the organization rather than a single credential, and a
 * restriction that only one of three doors honors is not a restriction. An API
 * key's own `allowedIps` still applies on top; the two intersect.
 *
 * Costs one primary-key read per authenticated request. It is deliberately not
 * cached: the whole point of the setting is to take effect when an operator
 * turns it on, and a cache would keep the previous origin authorized for as
 * long as its TTL.
 *
 * A malformed restriction fails closed — see {@link readAllowedIpAddresses} —
 * but a settings blob that will not parse at all does not. That asymmetry is
 * deliberate. A blob holding no readable JSON expresses no configuration, and
 * every other reader of this column already treats it as carrying none; turning
 * it into a denial here would lock an organization out of its API and its
 * dashboard at once, with no route left to undo it, over a row nobody can even
 * read. Inducing that state needs write access to the database, and anyone
 * holding that could clear the allowlist outright — so failing closed would buy
 * no protection and risk an outage that takes database access to repair.
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
    // The credential resolved against an organization that no longer exists.
    // There is no restriction to read, and the paths that own that failure
    // report it far better than an origin error would.
    return;
  }

  let allowedIpAddresses: unknown;
  try {
    allowedIpAddresses = readAllowedIpAddresses(row.settings);
  } catch (error) {
    // Logged at error level because it is a corruption we want to hear about,
    // and treated as no restriction for the reason given above.
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
