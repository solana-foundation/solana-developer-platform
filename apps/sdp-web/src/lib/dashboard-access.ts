import { type Action, organizationRoleMayPerform } from "@sdp/types/actions";
import { normalizeOrganizationRole, type OrganizationRole } from "@sdp/types/roles";

export interface DashboardCapabilities {
  canManageApiKeys: boolean;
  canManageCustody: boolean;
  canManageOrgSettings: boolean;
  canManageTokenAdmin: boolean;
  canManageTokenWrite: boolean;
  canUseWalletSignerCheck: boolean;
  canUseWalletFaucet: boolean;
}

/** Plain data: the project layout hands it to a client provider, so it holds no functions. */
export interface DashboardAccess {
  role: OrganizationRole;
  capabilities: DashboardCapabilities;
}

export function mapClerkRoleToDashboardRole(role: string | null | undefined): OrganizationRole {
  return normalizeOrganizationRole(role);
}

/** Whether this member's organization role holds an action, as the API decides it. */
export function dashboardRoleMayPerform(role: string | null | undefined, action: Action): boolean {
  return organizationRoleMayPerform(mapClerkRoleToDashboardRole(role), action);
}

export function resolveDashboardAccess(role: string | null | undefined): DashboardAccess {
  const resolvedRole = mapClerkRoleToDashboardRole(role);
  const mayPerform = (action: Action) => organizationRoleMayPerform(resolvedRole, action);

  return {
    role: resolvedRole,
    capabilities: {
      canManageApiKeys: mayPerform("api_keys.manage"),
      canManageCustody: mayPerform("wallets.configure"),
      canManageOrgSettings: mayPerform("organizations.manage"),
      canManageTokenAdmin: mayPerform("issuance.enforce"),
      canManageTokenWrite: mayPerform("issuance.manage"),
      // Current dashboard implementation creates a short-lived API key before signer check.
      canUseWalletSignerCheck: mayPerform("wallets.execute") && mayPerform("api_keys.manage"),
      canUseWalletFaucet: mayPerform("wallets.execute"),
    },
  };
}
