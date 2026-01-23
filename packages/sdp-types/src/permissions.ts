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

  // Wallet permissions
  "wallets:read",
  "wallets:write",

  // Compliance permissions
  "compliance:read",
  "compliance:write",

  // Webhook permissions
  "webhooks:read",
  "webhooks:write",

  // Audit log permissions
  "audit:read",

  // Organization management
  "org:read",
  "org:write",
  "org:admin",

  // API key management
  "api-keys:read",
  "api-keys:write",

  // Admin wildcard (all permissions)
  "*",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Organization roles and their default permissions
export const ORGANIZATION_ROLES = {
  owner: {
    description: "Full control, delete org, transfer ownership",
    permissions: ["*"] as Permission[],
  },
  admin: {
    description: "Manage members, API keys, settings",
    permissions: [
      "org:read",
      "org:write",
      "api-keys:read",
      "api-keys:write",
      "audit:read",
    ] as Permission[],
  },
  developer: {
    description: "Use API, create readonly keys",
    permissions: [
      "org:read",
      "api-keys:read",
      "tokens:read",
      "tokens:write",
      "payments:read",
      "payments:write",
      "wallets:read",
      "wallets:write",
      "webhooks:read",
      "webhooks:write",
    ] as Permission[],
  },
  viewer: {
    description: "Read-only dashboard access",
    permissions: [
      "org:read",
      "tokens:read",
      "payments:read",
      "wallets:read",
      "audit:read",
    ] as Permission[],
  },
} as const;

export type OrganizationRole = keyof typeof ORGANIZATION_ROLES;

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
export function getPermissionsForOrgRole(role: OrganizationRole): Permission[] {
  return [...ORGANIZATION_ROLES[role].permissions];
}

/**
 * Get default permissions for an API key role
 */
export function getPermissionsForApiKeyRole(role: ApiKeyRole): Permission[] {
  return [...API_KEY_ROLES[role].permissions];
}
