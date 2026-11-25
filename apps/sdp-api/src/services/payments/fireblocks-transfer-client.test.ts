import { createHash, generateKeyPairSync } from "node:crypto";
import {
  createFireblocksTransfer,
  type FireblocksTransferRequest,
  readFireblocksTransfer,
  resolveFireblocksTransferAsset,
} from "@sdp/custody/providers/fireblocks/transfers";
import type { CustodyProvisioningRuntime } from "@sdp/custody/shared/runtime";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";

const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address;
const USDT_MINT = WELL_KNOWN_TOKENS.USDT.mints["mainnet-beta"].address;

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = () => ({
  apiKey: crypto.randomUUID(),
  apiSecretPem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
function runtime(fetch: CustodyProvisioningRuntime["fetch"]): CustodyProvisioningRuntime {
  return {
    fetch,
    now: Date.now,
    sleep: async () => {},
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
        oneTimeAddress: { address: TEST_SOLANA_ADDRESSES.wallet2 },
      },
      note: "SDP payment",
    };
    const fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.fireblocks.io/v1/transactions");
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
          issuerAddress: USDC_MINT,
          decimals: 6,
        },
        {
          id: "wrong-mint",
          type: "SOL_ASSET",
          nativeAsset: "SOL",
          issuerAddress: USDT_MINT,
          decimals: 6,
        },
        {
          id: "SOL_USDC_PTHX",
          type: "SOL_ASSET",
          nativeAsset: "SOL",
          issuerAddress: USDC_MINT,
          decimals: 6,
        },
      ])
    );
    const credentials = access();
    const rt = runtime(fetch);
    const results = await Promise.all([
      resolveFireblocksTransferAsset(rt, credentials, "SOL", USDC_MINT),
      resolveFireblocksTransferAsset(rt, credentials, "SOL", USDC_MINT),
    ]);
    expect(results).toEqual([
      { id: "SOL_USDC_PTHX", decimals: 6 },
      { id: "SOL_USDC_PTHX", decimals: 6 },
    ]);
    await expect(resolveFireblocksTransferAsset(rt, credentials, "SOL", SOL_MINT)).rejects.toThrow(
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
          {
            id: "usdc",
            type: "SOL_ASSET",
            nativeAsset: "SOL",
            issuerAddress: USDC_MINT,
            decimals: 6,
          },
        ])
      );
    const credentials = access();
    const rt = runtime(fetch);
    await expect(
      resolveFireblocksTransferAsset(rt, credentials, "SOL", USDC_MINT)
    ).rejects.toThrow();
    expect(await resolveFireblocksTransferAsset(rt, credentials, "SOL", USDC_MINT)).toEqual({
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
    expect(await readFireblocksTransfer(rt, credentials, "xfr_1")).toEqual({
      id: "proposal",
      status: "PENDING_SIGNATURE",
    });
    expect(await readFireblocksTransfer(rt, credentials, "xfr_1")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe("https://api.fireblocks.io/v1/transactions/external_tx_id/xfr_1");
      expect(init.method).toBe("GET");
    }
  });
});
