import { describe, expect, it } from "vitest";
import { z } from "zod";
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
  const exactConnectionRequest = {
    name: "Connection key",
    walletScope: "selected",
    provisionWallet: { connectionId: "cconn_selected" },
  } as const;

  it("uses an exact-Connection shape that the previous revision rejects", () => {
    const previousProvisioningSchema = z.object({
      walletScope: z.enum(["all", "selected"]),
      provisionWallet: z.boolean().optional(),
    });

    expect(apiKeyCreateSchema.safeParse(exactConnectionRequest).success).toBe(true);
    expect(previousProvisioningSchema.safeParse(exactConnectionRequest).success).toBe(false);
  });

  it("rejects the obsolete top-level connectionId shape", () => {
    expect(
      apiKeyCreateSchema.safeParse({
        ...exactConnectionRequest,
        provisionWallet: true,
        connectionId: "cconn_selected",
      }).success
    ).toBe(false);
  });
});
