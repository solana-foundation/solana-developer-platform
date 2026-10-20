/**
 * Roles.
 *
 * Callers are authorized by actions (./actions): an API key holds explicit
 * grants, and a member holds their organization role's actions. An API key's
 * wallet scope is a list of custody wallets, with no per-wallet permissions.
 */

// Organization roles. What each role may do is its list of actions
// (`ORGANIZATION_ROLE_ACTIONS` in ./actions).
export const ORGANIZATION_ROLES = ["admin", "member"] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];
export type LegacyOrganizationRole = OrganizationRole | "owner" | "developer" | "viewer";

export function normalizeOrganizationRole(
  role: LegacyOrganizationRole | string | null | undefined
): OrganizationRole {
  if (role === "admin" || role === "owner" || role === "org:admin" || role === "org:owner") {
    return "admin";
  }

  return "member";
}

// Project member roles. Project membership does not authorize routes (HOO-1972).
export const PROJECT_ROLES = ["admin", "developer", "viewer"] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];
