import { describe, expect, it } from "vitest";
import { apiKeyCreateSchema, apiKeyUpdateSchema } from "./schemas";

const validCreateRequest = {
  name: "Restricted key",
  walletScope: "all" as const,
};

describe("API key IP allowlist schemas", () => {
  it.each([
    "203.0.113.42",
    "203.0.113.0/24",
    "2001:db8::42",
    "2001:db8::/48",
  ])("accepts a valid IP address or CIDR range: %s", (allowedIp) => {
    expect(
      apiKeyCreateSchema.safeParse({
        ...validCreateRequest,
        allowedIps: [allowedIp],
      }).success
    ).toBe(true);
  });

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
