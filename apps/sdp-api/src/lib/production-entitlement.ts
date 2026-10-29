import {
  type OrganizationEntitlements,
  organizationEntitlementsSchema,
} from "@sdp/types/organization-entitlements";
import type { Context } from "hono";
import { parsePostgresJson } from "@/db/postgres-utils";
import { forbidden } from "@/lib/errors";
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

/** Whether this request's organization may act on production (APE-351). */
export function isProductionEntitled(c: Context<{ Bindings: Env }>): boolean {
  return c.get("organizationEntitlements").enableProductionProject === true;
}

export function productionNotEnabled() {
  return forbidden("Production is not enabled for this organization");
}
