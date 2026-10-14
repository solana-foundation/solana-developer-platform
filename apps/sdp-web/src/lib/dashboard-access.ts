import {
  type Action,
  normalizeOrganizationRole,
  type OrganizationRole,
  organizationRoleMayPerform,
} from "@sdp/types";

export interface DashboardCapabilities {
  canManageApiKeys: boolean;
  canManageCustody: boolean;
  canManageOrgSettings: boolean;
  canManageTokenAdmin: boolean;
  canManageTokenWrite: boolean;
  canUseWalletSignerCheck: boolean;
}

export interface DashboardAccess {
  role: OrganizationRole;
  /** Whether this member's organization role holds an action, as the API decides it. */
  mayPerform: (action: Action) => boolean;
  capabilities: DashboardCapabilities;
}

export function mapClerkRoleToDashboardRole(role: string | null | undefined): OrganizationRole {
  return normalizeOrganizationRole(role);
}

export function resolveDashboardAccess(role: string | null | undefined): DashboardAccess {
  const resolvedRole = mapClerkRoleToDashboardRole(role);
  const mayPerform = (action: Action) => organizationRoleMayPerform(resolvedRole, action);

  return {
    role: resolvedRole,
    mayPerform,
    capabilities: {
      canManageApiKeys: mayPerform("api_keys.manage"),
      canManageCustody: mayPerform("wallets.configure"),
      canManageOrgSettings: mayPerform("organizations.manage"),
      canManageTokenAdmin: mayPerform("issuance.enforce"),
      canManageTokenWrite: mayPerform("issuance.manage"),
      // Current dashboard implementation creates a short-lived API key before signer check.
      canUseWalletSignerCheck: mayPerform("wallets.execute") && mayPerform("api_keys.manage"),
    },
  };
}
