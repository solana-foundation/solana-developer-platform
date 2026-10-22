import { type Action, organizationRoleMayPerform } from "@sdp/types/actions";
import type { OrganizationRole } from "@sdp/types/roles";

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

/**
 * What the dashboard shows the member, from the role SDP holds for them
 * (`requestMemberRole`), never Clerk's.
 *
 * @param role - The caller's Organization Role.
 * @returns The role and the capabilities it grants.
 */
export function resolveDashboardAccess(role: OrganizationRole): DashboardAccess {
  const mayPerform = (action: Action) => organizationRoleMayPerform(role, action);

  return {
    role,
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
