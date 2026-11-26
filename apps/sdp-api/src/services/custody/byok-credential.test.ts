import { generateKeyPairSync } from "node:crypto";
import { afterEach, aroundEach, describe, expect, it, vi } from "vitest";
import { inSandboxScope } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { checkByokCredential, credentialPayload, parseByokCredential } from "./byok-credential";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fields = {
  apiKey: "tenant-api-key",
  apiSecretPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  vaultAccountId: "0",
};
const address = syntheticAddress(1);

afterEach(() => vi.restoreAllMocks());
aroundEach((runTest) => inSandboxScope(runTest));

describe("Fireblocks BYOK credentials", () => {
  it("parses only the stored provider's credential variant", () => {
    expect(parseByokCredential("privy", { appId: "app", appSecret: "secret" })).toEqual({
      provider: "privy",
      appId: "app",
      appSecret: "secret",
    });
    expect(() => parseByokCredential("unknown", { appId: "app", appSecret: "secret" })).toThrow();
    expect(() =>
      parseByokCredential("fireblocks", {
        provider: "privy",
        appId: "app",
        appSecret: "secret",
      })
    ).toThrow();
    expect(() =>
      parseByokCredential("privy", {
        appId: "app",
        appSecret: "secret",
        apiKey: fields.apiKey,
      })
    ).toThrow();
    expect(() => parseByokCredential("fireblocks", { ...fields, assetId: "ETH" })).toThrow();
  });

  it("normalizes RSA PEM and pins the asset to the project environment", () => {
    const sandbox = credentialPayload("fireblocks", fields, "sandbox");
    expect(sandbox.assetId).toBe("SOL_TEST");
    expect(sandbox.apiSecretPem).toContain("BEGIN PRIVATE KEY");
    expect(credentialPayload("fireblocks", fields, "production").assetId).toBe("SOL");
    expect(() => credentialPayload("fireblocks", fields, undefined)).toThrow();
    expect(() =>
      credentialPayload("fireblocks", { ...fields, apiSecretPem: "invalid" }, "sandbox")
    ).toThrow();
    expect(() =>
      credentialPayload("fireblocks", { appId: "app", appSecret: "secret" }, "sandbox")
    ).toThrow();
    expect(() =>
      parseByokCredential("fireblocks", { appId: "app", appSecret: "secret" })
    ).toThrow();
    expect(() => parseByokCredential("fireblocks", fields)).toThrow();
  });

  it("uses one authenticated keychain read without proposing or broadcasting a transaction", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ addresses: [{ address }] }));
    const credential = parseByokCredential(
      "fireblocks",
      credentialPayload("fireblocks", fields, "sandbox")
    );
    const result = await checkByokCredential(credential);
    expect(result).toEqual({
      status: "success",
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      wallet: { walletId: "fb_0", address },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://sandbox-api.fireblocks.io/v1/vault/accounts/0/SOL_TEST/addresses_paginated",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-API-Key": fields.apiKey,
          Authorization: expect.stringMatching(/^Bearer /),
        }),
      })
    );
  });

  it("allows API-user rotation but binds continuity to the vault address, ID and asset", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ addresses: [{ address }] })
    );
    const auth = (overrides = {}) =>
      parseByokCredential("fireblocks", {
        ...credentialPayload("fireblocks", fields, "sandbox"),
        ...overrides,
      });
    const first = await checkByokCredential(auth());
    expect(first.status).toBe("success");
    expect(await checkByokCredential(auth({ apiKey: "new-api-user" }))).toEqual(first);
    expect(await checkByokCredential(auth({ vaultAccountId: "1" }))).not.toEqual(first);
    expect(await checkByokCredential(auth({ assetId: "SOL" }))).not.toEqual(first);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({ addresses: [{ address: syntheticAddress(2) }] })
    );
    expect(await checkByokCredential(auth())).not.toEqual(first);
  });

  it.each([
    [401, "failed"],
    [403, "failed"],
    [404, "failed"],
    [429, "retry_unknown"],
    [500, "retry_unknown"],
  ] as const)(
    "classifies HTTP %s as %s without exposing provider response bodies",
    async (status, expected) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("sensitive upstream body", { status })
      );
      const result = await checkByokCredential(
        parseByokCredential("fireblocks", credentialPayload("fireblocks", fields, "sandbox"))
      );
      expect(result).toEqual({ status: expected });
    }
  );

  it("keeps malformed or transient responses retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network unavailable"));
    expect(
      await checkByokCredential(
        parseByokCredential("fireblocks", credentialPayload("fireblocks", fields, "sandbox"))
      )
    ).toEqual({ status: "retry_unknown" });
  });
});
