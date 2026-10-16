import { describe, expect, it } from "vitest";
import { apiKeyCreateSchema, apiKeyUpdateSchema } from "./schemas";

const validCreateRequest = {
  name: "Restricted key",
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

describe("API key wallet provisioning schema", () => {
  const provisioningRequest = {
    name: "Provisioning key",
    walletScope: "selected",
  } as const;

  it.each([{ connectionId: "cconn_selected" }, { provider: "privy" }] as const)(
    "accepts a provisioning owner that names one provider account: %j",
    (provisionWallet) => {
      expect(
        apiKeyCreateSchema.safeParse({ ...provisioningRequest, provisionWallet }).success
      ).toBe(true);
    }
  );

  it.each([
    true,
    false,
    {},
    { connectionId: "cconn_selected", provider: "privy" },
    { connectionId: "" },
    { provider: "not_a_provider" },
  ])(
    "rejects a provisioning owner that names no single provider account: %j",
    (provisionWallet) => {
      expect(
        apiKeyCreateSchema.safeParse({ ...provisioningRequest, provisionWallet }).success
      ).toBe(false);
    }
  );

  it("rejects the obsolete top-level connectionId beside a valid owner", () => {
    expect(
      apiKeyCreateSchema.safeParse({
        ...provisioningRequest,
        provisionWallet: { connectionId: "cconn_selected" },
        connectionId: "cconn_selected",
      }).success
    ).toBe(false);
  });
});
