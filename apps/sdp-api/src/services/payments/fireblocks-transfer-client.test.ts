import { createHash, generateKeyPairSync } from "node:crypto";
import {
  createFireblocksTransfer,
  type FireblocksTransferRequest,
  readFireblocksTransfer,
  resolveFireblocksTransferAsset,
} from "@sdp/custody/provisioning/fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "@sdp/custody/provisioning/runtime";
import { jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = () => ({
  apiKey: crypto.randomUUID(),
  apiSecretPem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  apiBaseUrl: "https://fireblocks.example.test",
});
function runtime(fetch: CustodyProvisioningRuntime["fetch"]): CustodyProvisioningRuntime {
  return {
    fetch,
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
    sleep: async () => {},
    getRandomValues: (data) => crypto.getRandomValues(new Uint8Array(data)),
    sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  };
}

describe("native Fireblocks HTTP protocol", () => {
  it.each([
    { source: { type: "VAULT_ACCOUNT", id: 0 } },
    { destinationAddress: {} },
    { amountInfo: { amount: 0.01 } },
    { amountInfo: { netAmount: "-0.01" } },
    { amountInfo: { requestedAmount: "1e-2" } },
  ])("rejects malformed provider settlement fields: %j", async (patch) => {
    const fetch = vi.fn(async () =>
      Response.json({ id: "proposal", status: "COMPLETED", ...patch })
    );
    await expect(readFireblocksTransfer(runtime(fetch), access(), "xfr_1")).rejects.toThrow(
      "Invalid Fireblocks transfer response"
    );
  });
  it("signs the exact TRANSFER body and URI with the customer's RSA key and permanent idempotency ID", async () => {
    const credentials = access();
    const body: FireblocksTransferRequest = {
      operation: "TRANSFER",
      externalTxId: "xfr_intent",
      assetId: "SOL",
      amount: "0.01",
      treatAsGrossAmount: false,
      source: { type: "VAULT_ACCOUNT", id: "42" },
      destination: {
        type: "ONE_TIME_ADDRESS",
        oneTimeAddress: { address: "11111111111111111111111111111111" },
      },
      note: "SDP payment",
    };
    const fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://fireblocks.example.test/v1/transactions");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(init.body).toBe(JSON.stringify(body));
      const headers = new Headers(init.headers);
      expect(headers.get("X-API-Key")).toBe(credentials.apiKey);
      expect(headers.has("Idempotency-Key")).toBe(false);
      const authorization = headers.get("Authorization");
      if (!authorization) throw new Error("Missing authorization header");
      const { payload } = await jwtVerify(authorization.slice(7), rsa.publicKey);
      expect(payload).toMatchObject({
        sub: credentials.apiKey,
        uri: "/v1/transactions",
        bodyHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      });
      return Response.json({ id: "proposal", status: "SUBMITTED" });
    });
    expect(await createFireblocksTransfer(runtime(fetch), credentials, body)).toMatchObject({
      id: "proposal",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares catalogue reads and resolves the exact Solana issuer mint, never a similarly named asset", async () => {
    const fetch = vi.fn(async () =>
      Response.json([
        {
          id: "wrong-chain",
          type: "SOL_ASSET",
          nativeAsset: "SOL_TEST",
          issuerAddress: "mint",
          decimals: 6,
        },
        {
          id: "wrong-mint",
          type: "SOL_ASSET",
          nativeAsset: "SOL",
          issuerAddress: "different",
          decimals: 6,
        },
        {
          id: "SOL_USDC_PTHX",
          type: "SOL_ASSET",
          nativeAsset: "SOL",
          issuerAddress: "mint",
          decimals: 6,
        },
      ])
    );
    const credentials = access();
    const rt = runtime(fetch);
    const results = await Promise.all([
      resolveFireblocksTransferAsset(rt, credentials, "SOL", "mint"),
      resolveFireblocksTransferAsset(rt, credentials, "SOL", "mint"),
    ]);
    expect(results).toEqual([
      { id: "SOL_USDC_PTHX", decimals: 6 },
      { id: "SOL_USDC_PTHX", decimals: 6 },
    ]);
    await expect(resolveFireblocksTransferAsset(rt, credentials, "SOL", "unknown")).rejects.toThrow(
      "not uniquely supported"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not cache catalogue failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json([
          { id: "usdc", type: "SOL_ASSET", nativeAsset: "SOL", issuerAddress: "mint", decimals: 6 },
        ])
      );
    const credentials = access();
    const rt = runtime(fetch);
    await expect(resolveFireblocksTransferAsset(rt, credentials, "SOL", "mint")).rejects.toThrow();
    expect(await resolveFireblocksTransferAsset(rt, credentials, "SOL", "mint")).toEqual({
      id: "usdc",
      decimals: 6,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("recovers by GET only, tolerates null optional provider fields, and treats 404 as unresolved", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: "proposal",
          status: "PENDING_SIGNATURE",
          subStatus: null,
          txHash: null,
        })
      )
      .mockResolvedValueOnce(Response.json({}, { status: 404 }));
    const credentials = access();
    const rt = runtime(fetch);
    expect(await readFireblocksTransfer(rt, credentials, "xfr_1")).toMatchObject({
      status: "PENDING_SIGNATURE",
    });
    expect(await readFireblocksTransfer(rt, credentials, "xfr_1")).toBeNull();
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe("https://fireblocks.example.test/v1/transactions/external_tx_id/xfr_1");
      expect(init.method).toBe("GET");
    }
  });
});
