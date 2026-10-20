import { describe, expect, it } from "vitest";
import { apiKeyCreateSchema, apiKeyUpdateSchema } from "./schemas";

const validCreateRequest = {
  name: "Restricted key",
  grants: ["transfers.read"],
  walletScope: "all" as const,
};

describe("API key IP allowlist schemas", () => {
  it.each(["203.0.113.42", "203.0.113.0/24", "2001:db8::42", "2001:db8::/48"])(
    "accepts a valid IP address or CIDR range: %s",
    (allowedIp) => {
      expect(
        apiKeyCreateSchema.safeParse({
          ...validCreateRequest,
          allowedIps: [allowedIp],
        }).success
      ).toBe(true);
    }
  );

  it.each([
    "",
    "not-an-ip",
    "203.0.113.0/33",
    "2001:db8::/129",
    "203.0.113.0/not-a-prefix",
    "203.0.113.0/24/extra",
    " 203.0.113.0/24",
  ])("rejects a malformed IP allowlist entry: %s", (allowedIp) => {
    expect(
      apiKeyCreateSchema.safeParse({
        ...validCreateRequest,
        allowedIps: [allowedIp],
      }).success
    ).toBe(false);
    expect(apiKeyUpdateSchema.safeParse({ allowedIps: [allowedIp] }).success).toBe(false);
  });
});

// Creating a key never creates a wallet (HOO-2099).
describe("API key create refuses wallet provisioning", () => {
  const request = { name: "Key", grants: ["transfers.read"], walletScope: "selected" } as const;

  it.each([
    { provisionWallet: { connectionId: "cconn_selected" } },
    { provisionWallet: { provider: "privy" } },
    { walletLabel: "Treasury" },
    { walletPurpose: "transfer" },
    { connectionId: "cconn_selected" },
  ])("refuses %j", (field) => {
    const parsed = apiKeyCreateSchema.safeParse({ ...request, ...field });
    expect(parsed.success).toBe(false);
  });

  it("points a retired provisioning field at creating the wallet first", () => {
    const parsed = apiKeyCreateSchema.safeParse({
      ...request,
      provisionWallet: { provider: "privy" },
    });
    expect(JSON.stringify(parsed.error?.issues)).toContain("POST /v1/wallets");
  });
});

describe("API key grants schema", () => {
  it("requires grants on create, and accepts an empty list", () => {
    const { grants: _grants, ...withoutGrants } = validCreateRequest;
    expect(apiKeyCreateSchema.safeParse(withoutGrants).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...validCreateRequest, grants: [] }).success).toBe(true);
  });

  it.each(["transfers.everything", "payments:write", "*"])(
    "refuses an unknown grant %s",
    (grant) => {
      expect(apiKeyCreateSchema.safeParse({ ...validCreateRequest, grants: [grant] }).success).toBe(
        false
      );
      expect(apiKeyUpdateSchema.safeParse({ grants: [grant] }).success).toBe(false);
    }
  );

  it.each([
    "api_keys.manage",
    "members.read",
    "organizations.manage",
    "projects.manage",
    "wallets.configure",
  ])("refuses %s, which no API key may hold", (grant) => {
    expect(apiKeyCreateSchema.safeParse({ ...validCreateRequest, grants: [grant] }).success).toBe(
      false
    );
    expect(apiKeyUpdateSchema.safeParse({ grants: [grant] }).success).toBe(false);
  });

  it("refuses a repeated grant", () => {
    expect(
      apiKeyCreateSchema.safeParse({
        ...validCreateRequest,
        grants: ["transfers.read", "transfers.read"],
      }).success
    ).toBe(false);
  });
});

describe("API key fields retired by grants", () => {
  const retired = [
    ["role", "api_developer"],
    ["permissions", ["payments:read"]],
    ["allowedOperations", ["payment"]],
  ] as const;

  function firstMessage(result: { success: boolean; error?: { issues: { message: string }[] } }) {
    return result.error?.issues[0]?.message;
  }

  it.each(retired)("refuses %s on create, pointing at grants", (field, value) => {
    const result = apiKeyCreateSchema.safeParse({ ...validCreateRequest, [field]: value });
    expect(result.success).toBe(false);
    expect(firstMessage(result)).toBe(
      `${field} is no longer accepted: send grants, the explicit module.verb actions the key holds`
    );
  });

  it.each(retired)(
    "refuses %s on update beside a valid field, instead of stripping it",
    (field, value) => {
      const result = apiKeyUpdateSchema.safeParse({ name: "ci", [field]: value });
      expect(result.success).toBe(false);
      expect(firstMessage(result)).toMatch(
        new RegExp(`^${field} is no longer accepted: send grants`)
      );
    }
  );
});
