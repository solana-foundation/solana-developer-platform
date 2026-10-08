import type { OrganizationSettings } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { forbidden } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

/**
 * Whether an organization's raw `settings` column grants production access
 * (`enableProductionProject`, synced from Clerk).
 *
 * Fails closed: unparseable settings grant nothing. Unlike the IP allowlist,
 * where an unreadable blob expresses no restriction, this is the grant itself.
 */
export function isProductionEntitled(rawSettings: string | null, organizationId: string): boolean {
  if (rawSettings === null) {
    return false;
  }
  try {
    return (
      parsePostgresJson<OrganizationSettings | null>(rawSettings)?.enableProductionProject === true
    );
  } catch (error) {
    getLogger().error(
      { error, organizationId },
      "Organization settings could not be parsed; production access denied"
    );
    return false;
  }
}

export function productionNotEnabled() {
  return forbidden("Production is not enabled for this organization");
}

/**
 * Records the entitlement read from an `organizations` row this request
 * already loaded (authentication reads it for the IP allowlist), so the
 * project-scope check costs no second read.
 */
export function recordProductionEntitlement(
  c: Context<{ Bindings: Env }>,
  organizationId: string,
  rawSettings: string | null
): void {
  c.set("productionEntitlement", {
    organizationId,
    entitled: isProductionEntitled(rawSettings, organizationId),
  });
}

/**
 * Whether the organization may act on production in this request. Uses the
 * entitlement recorded during authentication; a door that recorded none (an
 * approved-operation replay, a Clerk organization first provisioned by this
 * request) costs one primary-key read here instead.
 *
 * Deliberately uncached across requests, like the IP allowlist: revoking the
 * entitlement takes effect on the next request.
 */
export async function isOrganizationProductionEntitled(
  c: Context<{ Bindings: Env }>,
  organizationId: string
): Promise<boolean> {
  const recorded = c.get("productionEntitlement");
  if (recorded?.organizationId === organizationId) {
    return recorded.entitled;
  }

  const row = await getDb(c.env)
    .prepare("SELECT settings FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ settings: string | null }>();
  return !!row && isProductionEntitled(row.settings, organizationId);
}

/**
 * Refuses an action on a production project whose organization lacks the
 * production entitlement, for the one public route that acts on a project
 * without an authenticated actor (`/pay`, scoped by its payment request).
 * `/pay` already runs under its own system identity (middleware/database-identity.ts),
 * so this read sees the organization row.
 */
export async function assertProjectProductionAllowed(
  env: Env,
  organizationId: string,
  projectId: string
): Promise<void> {
  const row = await getDb(env)
    .prepare(
      `SELECT p.environment, o.settings
       FROM projects p
       JOIN organizations o ON o.id = p.organization_id
       WHERE p.id = ? AND p.organization_id = ?`
    )
    .bind(projectId, organizationId)
    .first<{ environment: string; settings: string | null }>();
  if (
    !row ||
    (row.environment === "production" && !isProductionEntitled(row.settings, organizationId))
  ) {
    throw productionNotEnabled();
  }
}
