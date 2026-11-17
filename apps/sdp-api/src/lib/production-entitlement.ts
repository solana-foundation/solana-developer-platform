import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type OrganizationEntitlements,
  organizationEntitlementsSchema,
} from "@sdp/types/organization-entitlements";
import { ORGANIZATION_NOT_ADMITTED_REASON } from "@sdp/types/organizations";
import type { Context } from "hono";
import { z } from "zod";
import { parsePostgresJson } from "@/db/postgres-utils";
import { forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * Whether this deployment may admit a production project at all
 * (`SDP_ALLOW_PRODUCTION_PROJECTS`). Unset allows; an explicit `false` means
 * the deployment never admits one, whatever an organization's entitlement
 * says: a devnet-only deployment sets it. Any other value throws, so a typo
 * fails at boot instead of reading as allowed.
 *
 * @param env - Process environment.
 * @returns False only when the deployment refuses production projects.
 */
export function productionProjectsAllowed(
  env: Pick<Env, "SDP_ALLOW_PRODUCTION_PROJECTS">
): boolean {
  const parsed = allowProductionProjectsSchema.safeParse(env.SDP_ALLOW_PRODUCTION_PROJECTS);
  if (!parsed.success) {
    throw new Error(
      `Invalid SDP_ALLOW_PRODUCTION_PROJECTS: "${env.SDP_ALLOW_PRODUCTION_PROJECTS}". Expected "true" or "false".`
    );
  }
  return parsed.data;
}

const allowProjectsSchema = z
  .string()
  .trim()
  .pipe(z.enum(["true", "false"]))
  .optional()
  .transform((value) => value !== "false");
const allowProductionProjectsSchema = allowProjectsSchema;

/**
 * Whether this deployment may admit a sandbox project at all
 * (`SDP_ALLOW_SANDBOX_PROJECTS`), the mirror of {@link productionProjectsAllowed}.
 * Unset allows; an explicit `false` means the deployment is mainnet-only: it
 * hides and refuses every sandbox project, creates none, and admits only
 * organizations that hold the production entitlement. Any other value throws.
 *
 * @param env - Process environment.
 * @returns False only when the deployment refuses sandbox projects.
 */
export function sandboxProjectsAllowed(env: Pick<Env, "SDP_ALLOW_SANDBOX_PROJECTS">): boolean {
  const parsed = allowProjectsSchema.safeParse(env.SDP_ALLOW_SANDBOX_PROJECTS);
  if (!parsed.success) {
    throw new Error(
      `Invalid SDP_ALLOW_SANDBOX_PROJECTS: "${env.SDP_ALLOW_SANDBOX_PROJECTS}". Expected "true" or "false".`
    );
  }
  return parsed.data;
}

/** Whether this deployment admits projects of the environment. */
export function environmentAllowed(
  env: Pick<Env, "SDP_ALLOW_PRODUCTION_PROJECTS" | "SDP_ALLOW_SANDBOX_PROJECTS">,
  environment: SdpEnvironment
): boolean {
  return environment === "production"
    ? productionProjectsAllowed(env)
    : sandboxProjectsAllowed(env);
}

/**
 * Throws unless the deployment admits at least one environment, and both settings parse, so a
 * deployment that could serve nothing fails at boot.
 */
export function assertProjectEnvironmentsConfig(
  env: Pick<Env, "SDP_ALLOW_PRODUCTION_PROJECTS" | "SDP_ALLOW_SANDBOX_PROJECTS">
): void {
  const production = productionProjectsAllowed(env);
  const sandbox = sandboxProjectsAllowed(env);
  if (!production && !sandbox) {
    throw new Error(
      "SDP_ALLOW_PRODUCTION_PROJECTS and SDP_ALLOW_SANDBOX_PROJECTS cannot both be false"
    );
  }
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
  // Unset when no organization authenticated the request: nothing is entitled.
  return c.get("organizationEntitlements")?.enableProductionProject === true;
}

export function productionNotEnabled() {
  return forbidden("Production is not enabled for this organization");
}

export function sandboxNotAvailable() {
  return forbidden("Sandbox projects are not available on this deployment");
}

/**
 * Whether this request's organization may use this deployment beyond its own
 * mainnet access status. Everywhere sandbox projects are admitted, every
 * organization is; on a mainnet-only deployment only an organization that
 * holds the production entitlement is.
 */
export function isOrganizationAdmitted(c: Context<{ Bindings: Env }>): boolean {
  return sandboxProjectsAllowed(c.env) || isProductionEntitled(c);
}

/** The refusal a mainnet-only deployment gives an organization without mainnet access. */
export function organizationNotAdmitted() {
  return forbidden("This organization is not approved for mainnet on this deployment", {
    reason: ORGANIZATION_NOT_ADMITTED_REASON,
  });
}
