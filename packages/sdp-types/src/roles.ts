/**
 * Roles.
 *
 * Callers are authorized by actions (./actions): an API key holds explicit
 * grants, and a member holds their organization role's actions. An API key's
 * wallet scope is a list of custody wallets, with no per-wallet permissions.
 */

// Organization roles. What each role may do is its list of actions
// (`ORGANIZATION_ROLE_ACTIONS` in ./actions). A `viewer` only reads.
export const ORGANIZATION_ROLES = ["admin", "member", "viewer"] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];
export type LegacyOrganizationRole = OrganizationRole | "owner" | "developer";

/**
 * The role a stored or legacy value grants. A value no role names reads as
 * `viewer`, so an unexpected row fails closed to reading.
 */
export function normalizeOrganizationRole(
  role: LegacyOrganizationRole | string | null | undefined
): OrganizationRole {
  if (role === "admin" || role === "owner" || role === "org:admin" || role === "org:owner") {
    return "admin";
  }
  if (role === "member" || role === "developer" || role === "org:member") {
    return "member";
  }

  return "viewer";
}
