import { describe, expect, it } from "vitest";
import { type DashboardAccess, resolveDashboardAccess } from "./dashboard-access";

describe("resolveDashboardAccess", () => {
  it.each<DashboardAccess>([
    {
      role: "admin",
      capabilities: {
        canWrite: true,
        canManageApiKeys: true,
        canManageCustody: true,
        canManageOrgSettings: true,
        canManageTokenAdmin: true,
        canManageTokenWrite: true,
        canUseWalletSignerCheck: true,
        canUseWalletFaucet: true,
      },
    },
    {
      role: "member",
      capabilities: {
        canWrite: true,
        canManageApiKeys: false,
        canManageCustody: false,
        canManageOrgSettings: false,
        canManageTokenAdmin: false,
        canManageTokenWrite: true,
        canUseWalletSignerCheck: false,
        canUseWalletFaucet: false,
      },
    },
    {
      role: "viewer",
      capabilities: {
        canWrite: false,
        canManageApiKeys: false,
        canManageCustody: false,
        canManageOrgSettings: false,
        canManageTokenAdmin: false,
        canManageTokenWrite: false,
        canUseWalletSignerCheck: false,
        canUseWalletFaucet: false,
      },
    },
  ])("grants $role the capabilities its SDP role holds, as plain data", (expected) => {
    const access = resolveDashboardAccess(expected.role);
    expect(access).toEqual(expected);
    expect(structuredClone(access)).toEqual(expected);
  });
});
