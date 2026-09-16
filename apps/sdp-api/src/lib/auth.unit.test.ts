import { describe, expect, it } from "vitest";
import { type ApiKeyContext, canManageOrganizationCredentials } from "./auth";

const base = {
  id: "usr_test",
  organizationId: "org_test",
  projectId: "prj_test",
  environment: "dashboard",
  walletScope: null,
  signingWalletId: null,
  signingWalletIds: [],
  walletBindings: [],
};

describe("canManageOrganizationCredentials", () => {
  it("recognizes a normalized Clerk admin role even when its permission claim is incomplete", () => {
    const auth: ApiKeyContext = {
      ...base,
      authType: "clerk",
      apiKeyId: null,
      userId: "usr_test",
      role: "admin",
      permissions: ["payments:read"],
    };

    expect(canManageOrganizationCredentials(auth)).toBe(true);
  });

  it("recognizes an administrator resolved through a dashboard session", () => {
    const auth: ApiKeyContext = {
      ...base,
      authType: "session",
      apiKeyId: null,
      userId: "usr_test",
      role: "session",
      permissions: ["org:admin"],
    };

    expect(canManageOrganizationCredentials(auth)).toBe(true);
  });

  it("rejects members and API keys, including wildcard API keys", () => {
    const member: ApiKeyContext = {
      ...base,
      authType: "clerk",
      apiKeyId: null,
      userId: "usr_test",
      role: "member",
      permissions: ["payments:read"],
    };
    const apiKey: ApiKeyContext = {
      ...base,
      authType: "api_key",
      apiKeyId: "key_test",
      userId: null,
      role: "api_admin",
      permissions: ["*"],
    };

    expect(canManageOrganizationCredentials(member)).toBe(false);
    expect(canManageOrganizationCredentials(apiKey)).toBe(false);
  });
});
