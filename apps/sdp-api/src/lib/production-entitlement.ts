import {
  type OrganizationEntitlements,
  organizationEntitlementsSchema,
} from "@sdp/types/organization-entitlements";
import type { Context } from "hono";
import { parsePostgresJson } from "@/db/postgres-utils";
import { forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * Whether this deployment may admit a production project at all
 * (`SDP_ALLOW_PRODUCTION_PROJECTS`). Unset allows; an explicit `false` means
 * the deployment never admits one, whatever an organization's Clerk
 * entitlement says: a devnet-only deployment sharing the production Clerk
 * instance sets it. Any other value throws, so a typo fails at boot instead of
 * reading as allowed.
 *
 * @param env - Process environment.
 * @returns False only when the deployment refuses production projects.
 */
export function productionProjectsAllowed(
  env: Pick<Env, "SDP_ALLOW_PRODUCTION_PROJECTS">
): boolean {
  const value = env.SDP_ALLOW_PRODUCTION_PROJECTS?.trim();
  if (value === undefined || value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid SDP_ALLOW_PRODUCTION_PROJECTS: "${value}". Expected "true" or "false".`);
}

/**
 * Parses an organization's raw `settings` column into its entitlements. A
 * missing row or column grants nothing. The column is JSON the API writes
 * itself, so a value that does not parse is a bug: it throws, and the request
 * fails loudly with a 500 rather than reading as "not entitled". On a
 * deployment that refuses production projects the production entitlement is
 * dropped, so no caller can read it as granted.
 *
 * @param rawSettings - The stored column.
 * @param productionAllowed - {@link productionProjectsAllowed} for this deployment.
 * @returns The entitlements this deployment honours.
 */
export function parseOrganizationEntitlements(
  rawSettings: string | null,
  productionAllowed: boolean
): OrganizationEntitlements {
  if (rawSettings === null) {
    return {};
  }
  const entitlements = organizationEntitlementsSchema.parse(
    parsePostgresJson<unknown>(rawSettings) ?? {}
  );
  if (productionAllowed) {
    return entitlements;
  }
  const { enableProductionProject: _refused, ...honoured } = entitlements;
  return honoured;
}

/** Records the entitlements authentication loaded for this request's organization. */
export function recordOrganizationEntitlements(
  c: Context<{ Bindings: Env }>,
  rawSettings: string | null
): void {
  c.set(
    "organizationEntitlements",
    parseOrganizationEntitlements(rawSettings, productionProjectsAllowed(c.env))
  );
}

/** Whether this request's organization may act on production (APE-351). */
export function isProductionEntitled(c: Context<{ Bindings: Env }>): boolean {
  return c.get("organizationEntitlements").enableProductionProject === true;
}

export function productionNotEnabled() {
  return forbidden("Production is not enabled for this organization");
}
