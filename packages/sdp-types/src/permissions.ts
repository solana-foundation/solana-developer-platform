/**
 * Legacy permission strings.
 *
 * Callers are authorized by actions (./actions): an API key holds explicit
 * grants and a member holds their organization role's actions. These strings
 * remain only as the vocabulary of an API key's per-wallet bindings
 * (`api_key_wallet_permissions`), which the wallet-scope work replaces.
 */

// Resource-level permissions
export const PERMISSIONS = [
  // Token/Issuance permissions
  "tokens:read",
  "tokens:write",
  "tokens:admin",

  // Payment permissions
  "payments:read",
  "payments:write",

  // Earn permissions
  "earn:read",
  "earn:write",

  // Counterparty permissions
  "counterparties:read",
  "counterparties:write",

  // Wallet permissions
  "wallets:read",
  "wallets:write",

  // Compliance permissions
  "compliance:read",
  "compliance:write",

  // Webhook permissions
  "webhooks:read",
  "webhooks:write",

  // Transaction permissions
  "transactions:read",
  "transactions:write",

  // Audit log permissions
  "audit:read",

  // Organization management
  "org:read",
  "org:write",
  "org:admin",

  // API key management
  "api-keys:read",
  "api-keys:write",

  // Project management
  "projects:read",
  "projects:write",
  "projects:admin",

  // Project member management
  "project-members:read",
  "project-members:write",

  // Session management
  "sessions:read",
  "sessions:write",

  // Custody/signing key management
  "custody:read",
  "custody:write",
  "custody:admin",

  // Wildcard: a wallet binding with full access to its wallet
  "*",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

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

// Project roles and their default permissions
export const PROJECT_ROLES = {
  admin: {
    description: "Full project control, manage members and API keys",
    permissions: [
      "projects:read",
      "projects:write",
      "project-members:read",
      "project-members:write",
      "api-keys:read",
      "api-keys:write",
    ] as Permission[],
  },
  developer: {
    description: "Use project API keys, read project info",
    permissions: [
      "projects:read",
      "api-keys:read",
      "tokens:read",
      "tokens:write",
      "payments:read",
      "payments:write",
      "earn:read",
      "earn:write",
      "counterparties:read",
      "counterparties:write",
      "wallets:read",
      "wallets:write",
    ] as Permission[],
  },
  viewer: {
    description: "Read-only project access",
    permissions: ["projects:read"] as Permission[],
  },
} as const;

export type ProjectRole = keyof typeof PROJECT_ROLES;

/**
 * Get default permissions for a project role
 */
export function getPermissionsForProjectRole(role: ProjectRole): Permission[] {
  return [...PROJECT_ROLES[role].permissions];
}
