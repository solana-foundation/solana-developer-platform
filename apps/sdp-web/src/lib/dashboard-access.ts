import {
  getPermissionsForOrgRole,
  hasPermission,
  normalizeOrganizationRole,
  type OrganizationRole,
  type Permission,
} from "@sdp/types";

export interface DashboardCapabilities {
  canManageApiKeys: boolean;
  canManageCustody: boolean;
  canManageOrgSettings: boolean;
  canManageTokenAdmin: boolean;
  canUseWalletSignerCheck: boolean;
}

export interface DashboardAccess {
  role: OrganizationRole;
  permissions: Permission[];
  capabilities: DashboardCapabilities;
}

export function mapClerkRoleToDashboardRole(role: string | null | undefined): OrganizationRole {
  return normalizeOrganizationRole(role);
}

export function resolveDashboardAccess(role: string | null | undefined): DashboardAccess {
  const resolvedRole = mapClerkRoleToDashboardRole(role);
  const permissions = getPermissionsForOrgRole(resolvedRole);

  return {
    role: resolvedRole,
    permissions,
    capabilities: {
      canManageApiKeys: hasPermission(permissions, "api-keys:write"),
      canManageCustody: hasPermission(permissions, "custody:admin"),
      canManageOrgSettings: hasPermission(permissions, "org:write"),
      canManageTokenAdmin: hasPermission(permissions, "tokens:admin"),
      // Current dashboard implementation creates a short-lived API key before signer check.
      canUseWalletSignerCheck:
        hasPermission(permissions, "wallets:write") && hasPermission(permissions, "api-keys:write"),
    },
  };
}
