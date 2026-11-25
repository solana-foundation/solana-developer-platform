import { afterEach, aroundEach, describe, expect, it, vi } from "vitest";
import { assertPrivyCredentialAccepted } from "@/services/custody/privy-credential";
import { inSandboxScope } from "@/test/helpers/cluster-rpc";

aroundEach((runTest) => inSandboxScope(runTest));

describe("assertPrivyCredentialAccepted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves when Privy accepts the credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));

    await expect(
      assertPrivyCredentialAccepted({ appId: "app-123", appSecret: "secret" })
    ).resolves.toBeUndefined();
  });

  it("refuses credentials Privy rejects as invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ code: "missing_or_invalid_privy_app_id" }, { status: 400 })
    );

    await expect(
      assertPrivyCredentialAccepted({ appId: "app-123", appSecret: "secret" })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
      message:
        "The provider rejected these credentials. Check the credential fields, then connect again.",
      details: { reason: "invalid_credentials" },
    });
  });

  it("refuses credentials Privy did not confirm", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "unavailable" }, { status: 503 })
    );

    await expect(
      assertPrivyCredentialAccepted({ appId: "app-123", appSecret: "secret" })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
      message: "Privy did not confirm these credentials, so nothing was saved. Try again.",
      details: { reason: "provider_unconfirmed" },
    });
  });
});
