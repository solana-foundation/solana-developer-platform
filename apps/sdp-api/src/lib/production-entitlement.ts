import {
  type OrganizationEntitlements,
  organizationEntitlementsSchema,
  organizationStatusMayAuthenticate,
} from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { forbidden } from "@/lib/errors";
import { organizationNotActive } from "@/lib/organization-access";
import type { Env } from "@/types/env";

/**
 * Parses an organization's raw `settings` column into its entitlements. A
 * missing row or column grants nothing. The column is JSON the API writes
 * itself, so a value that does not parse is a bug: it throws, and the request
 * fails loudly with a 500 rather than reading as "not entitled".
 */
export function parseOrganizationEntitlements(
  rawSettings: string | null
): OrganizationEntitlements {
  if (rawSettings === null) {
    return {};
  }
  return organizationEntitlementsSchema.parse(parsePostgresJson<unknown>(rawSettings) ?? {});
}

/** Records the entitlements authentication loaded for this request's organization. */
export function recordOrganizationEntitlements(
  c: Context<{ Bindings: Env }>,
  rawSettings: string | null
): void {
  c.set("organizationEntitlements", parseOrganizationEntitlements(rawSettings));
}

/**
 * Loads and records the entitlements for an authentication door that does not
 * already read the organization row (an approved-operation replay, a Clerk
 * organization first provisioned by this request). Uncached, so revoking an
 * entitlement takes effect on the next request; like every door's
 * organization read, it refuses an organization that is no longer `active`.
 */
export async function loadOrganizationEntitlements(
  c: Context<{ Bindings: Env }>,
  organizationId: string
): Promise<void> {
  const row = await getDb(c.env)
    .prepare("SELECT status, settings FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ status: string; settings: string | null }>();
  if (!row || !organizationStatusMayAuthenticate(row.status)) {
    throw organizationNotActive();
  }
  recordOrganizationEntitlements(c, row.settings);
}

/** Whether this request's organization may act on production (APE-351). */
export function isProductionEntitled(c: Context<{ Bindings: Env }>): boolean {
  return c.get("organizationEntitlements").enableProductionProject === true;
}

export function productionNotEnabled() {
  return forbidden("Production is not enabled for this organization");
}
