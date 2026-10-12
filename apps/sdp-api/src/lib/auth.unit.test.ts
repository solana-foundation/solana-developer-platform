import { describe, expect, it } from "vitest";
import { TEST_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { type ApiKeyContext, canManageOrganizationCredentials, requireAuthProjectId } from "./auth";

const base = {
  id: TEST_USER.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
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
      userId: TEST_USER.id,
      role: "admin",
      permissions: ["payments:read"],
    };

    expect(canManageOrganizationCredentials(auth)).toBe(true);
  });

  it("rejects members and API keys, including wildcard API keys", () => {
    const member: ApiKeyContext = {
      ...base,
      authType: "clerk",
      apiKeyId: null,
      userId: TEST_USER.id,
      role: "member",
      permissions: ["payments:read"],
    };
    const apiKey: ApiKeyContext = {
      ...base,
      authType: "api_key",
      apiKeyId: TEST_API_KEY.id,
      userId: null,
      role: "api_admin",
      permissions: ["*"],
    };

    expect(canManageOrganizationCredentials(member)).toBe(false);
    expect(canManageOrganizationCredentials(apiKey)).toBe(false);
  });
});

describe("requireAuthProjectId", () => {
  const member: ApiKeyContext = {
    ...base,
    authType: "clerk",
    apiKeyId: null,
    userId: TEST_USER.id,
    role: "member",
    permissions: ["payments:read"],
  };

  it("returns the project the auth context is scoped to", () => {
    expect(requireAuthProjectId(member)).toBe(TEST_PROJECT.id);
  });

  it("rejects an auth context with no project scope as a bad request", () => {
    expect(() => requireAuthProjectId({ ...member, projectId: null })).toThrow(
      expect.objectContaining({
        name: "AppError",
        code: "BAD_REQUEST",
        statusCode: 400,
        message: "Project scope is required",
      })
    );
  });
});
