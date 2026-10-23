import { generateKeyPairSync } from "node:crypto";
import { SignerError, SignerErrorCode } from "@solana/keychain-core";
import { FireblocksSigner } from "@solana/keychain-fireblocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "@/test/helpers/env";
import {
  byokCredentialCheckSchema,
  checkByokCredential,
  credentialPayload,
  parseByokCredential,
} from "./byok-credential";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fields = {
  apiKey: "tenant-api-key",
  apiSecretPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  vaultAccountId: "0",
};
const env = { ...testEnv, FIREBLOCKS_API_BASE_URL: "https://fireblocks.example.test" };
const address = "11111111111111111111111111111111";

afterEach(() => vi.restoreAllMocks());

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

  it("requires success evidence and forbids it on a failed or unknown check", () => {
    expect(byokCredentialCheckSchema.safeParse({ status: "success" }).success).toBe(false);
    expect(
      byokCredentialCheckSchema.safeParse({ status: "success", fingerprint: "" }).success
    ).toBe(false);
    for (const status of ["failed", "retry_unknown"] as const) {
      expect(byokCredentialCheckSchema.parse({ status })).toEqual({ status });
      expect(byokCredentialCheckSchema.safeParse({ status, fingerprint: "stale" }).success).toBe(
        false
      );
    }
    expect(byokCredentialCheckSchema.safeParse({ status: "unknown" }).success).toBe(false);
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
    const result = await checkByokCredential(env, credential);
    expect(result).toMatchObject({ status: "success", wallet: { walletId: "fb_0", address } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${env.FIREBLOCKS_API_BASE_URL}/v1/vault/accounts/0/SOL_TEST/addresses_paginated`,
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
    const first = await checkByokCredential(env, auth());
    expect(first.status).toBe("success");
    expect(await checkByokCredential(env, auth({ apiKey: "new-api-user" }))).toEqual(first);
    expect(await checkByokCredential(env, auth({ vaultAccountId: "1" }))).not.toEqual(first);
    expect(await checkByokCredential(env, auth({ assetId: "SOL" }))).not.toEqual(first);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({ addresses: [{ address: "So11111111111111111111111111111111111111112" }] })
    );
    expect(await checkByokCredential(env, auth())).not.toEqual(first);
  });

  it.each([401, 403, 404, 429, 500])(
    "classifies HTTP %s without exposing provider response bodies",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("sensitive upstream body", { status })
      );
      const result = await checkByokCredential(
        env,
        parseByokCredential("fireblocks", credentialPayload("fireblocks", fields, "sandbox"))
      );
      expect(result).toEqual({
        status: [401, 403, 404].includes(status) ? "failed" : "retry_unknown",
      });
    }
  );

  it("keeps malformed or transient responses retryable", async () => {
    vi.spyOn(FireblocksSigner, "create").mockRejectedValue(
      new SignerError(SignerErrorCode.IO_ERROR)
    );
    expect(
      await checkByokCredential(
        env,
        parseByokCredential("fireblocks", credentialPayload("fireblocks", fields, "sandbox"))
      )
    ).toEqual({ status: "retry_unknown" });
  });
});
