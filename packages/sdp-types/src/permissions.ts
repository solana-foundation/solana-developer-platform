/**
 * SDP Permission System
 *
 * Hierarchical permission model for API access control.
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

  // Admin wildcard (all permissions)
  "*",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Organization roles and their default permissions
export const ORGANIZATION_ROLES = {
  admin: {
    description: "Full organization control",
    permissions: [
      "org:read",
      "org:write",
      "org:admin",
      "tokens:read",
      "tokens:write",
      "tokens:admin",
      "payments:read",
      "payments:write",
      "counterparties:read",
      "counterparties:write",
      "wallets:read",
      "wallets:write",
      "webhooks:read",
      "webhooks:write",
      "api-keys:read",
      "api-keys:write",
      "projects:read",
      "projects:write",
      "projects:admin",
      "project-members:read",
      "project-members:write",
      "audit:read",
      "custody:read",
      "custody:admin",
    ] as Permission[],
  },
  member: {
    description: "Standard product access",
    permissions: [
      "org:read",
      "api-keys:read",
      "tokens:read",
      "tokens:write",
      "payments:read",
      "payments:write",
      "counterparties:read",
      "counterparties:write",
      "wallets:read",
      "wallets:write",
      "webhooks:read",
      "webhooks:write",
      "projects:read",
    ] as Permission[],
  },
} as const;

export type OrganizationRole = keyof typeof ORGANIZATION_ROLES;
export type LegacyOrganizationRole = OrganizationRole | "owner" | "developer" | "viewer";

export function normalizeOrganizationRole(
  role: LegacyOrganizationRole | string | null | undefined
): OrganizationRole {
  if (role === "admin" || role === "owner" || role === "org:admin" || role === "org:owner") {
    return "admin";
  }

  return "member";
}

// API key roles and their default permissions
export const API_KEY_ROLES = {
  api_admin: {
    description: "Full API access",
    permissions: ["*"] as Permission[],
  },
  api_developer: {
    description: "Standard API access for tokens, payments, wallets",
    permissions: [
      "tokens:read",
      "tokens:write",
      "payments:read",
      "payments:write",
      "counterparties:read",
      "counterparties:write",
      "wallets:read",
      "wallets:write",
      "compliance:read",
      "webhooks:read",
      "webhooks:write",
    ] as Permission[],
  },
  api_readonly: {
    description: "Read-only API access",
    permissions: [
      "tokens:read",
      "payments:read",
      "counterparties:read",
      "wallets:read",
      "compliance:read",
      "webhooks:read",
      "audit:read",
    ] as Permission[],
  },
} as const;

export type ApiKeyRole = keyof typeof API_KEY_ROLES;

/**
 * Check if a permission set includes a required permission
 */
export function hasPermission(userPermissions: Permission[], required: Permission): boolean {
  if (userPermissions.includes("*")) {
    return true;
  }
  return userPermissions.includes(required);
}

/**
 * Check if a permission set includes any of the required permissions
 */
export function hasAnyPermission(userPermissions: Permission[], required: Permission[]): boolean {
  if (userPermissions.includes("*")) {
    return true;
  }
  return required.some((p) => userPermissions.includes(p));
}

/**
 * Check if a permission set includes all required permissions
 */
export function hasAllPermissions(userPermissions: Permission[], required: Permission[]): boolean {
  if (userPermissions.includes("*")) {
    return true;
  }
  return required.every((p) => userPermissions.includes(p));
}

/**
 * Get default permissions for an organization role
 */
export function getPermissionsForOrgRole(
  role: LegacyOrganizationRole | string | null | undefined
): Permission[] {
  return [...ORGANIZATION_ROLES[normalizeOrganizationRole(role)].permissions];
}

/**
 * Get default permissions for an API key role
 */
export function getPermissionsForApiKeyRole(role: ApiKeyRole): Permission[] {
  return [...API_KEY_ROLES[role].permissions];
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
