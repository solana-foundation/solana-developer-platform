import { createKoraAdapter } from "@sdp/payments/fee-payment";
import { KoraAdapter } from "@sdp/payments/fee-payment/kora";
import type { KoraClient } from "@solana/kora";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signTransaction = vi.fn();
const signAndSendTransaction = vi.fn();
const getPayerSigner = vi.fn();
const getConfig = vi.fn();
const fakeClient = {
  signTransaction,
  signAndSendTransaction,
  getPayerSigner,
  getConfig,
} as unknown as KoraClient;

const TX = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  signTransaction.mockReset().mockResolvedValue({ signed_transaction: "AQIDBA==" });
  getPayerSigner.mockReset().mockResolvedValue({ signer_address: "FeePayer111" });
  getConfig.mockReset().mockResolvedValue({
    validation_config: {
      max_allowed_lamports: 1_000_000,
      fee_payer_policy: { allow_sol_transfers: false, allow_token_transfers: false },
    },
  });
  signAndSendTransaction.mockReset().mockResolvedValue({
    signature: "TEST_SIGNATURE",
    signed_transaction: "AQIDBA==",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KoraAdapter user_id forwarding", () => {
  it("forwards user_id on signAndSend when configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      userId: "usr_abc123",
      client: fakeClient,
    });
    await adapter.signAndSend(TX);
    expect(signAndSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "usr_abc123",
        signer_key: "FeePayer111",
        respond_after: "sent",
      })
    );
  });

  it("uses Kora config instead of free-pricing fee estimates", async () => {
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toEqual({
      signerAddress: "FeePayer111",
      maxAllowedLamports: 1_000_000n,
      feePayerMayTransferLamports: false,
    });
  });

  it("treats unknown fee-payer policy fields conservatively", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: { max_allowed_lamports: "2000000", fee_payer_policy: {} },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      maxAllowedLamports: 2_000_000n,
      feePayerMayTransferLamports: true,
    });
  });

  it("forwards user_id on signAsFeePayer when configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      userId: "usr_abc123",
      client: fakeClient,
    });
    await adapter.signAsFeePayer(TX);
    expect(signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "usr_abc123" })
    );
  });

  it("uses a fail-closed user_id on signAndSend when no scoped identity is configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      client: fakeClient,
    });
    await adapter.signAndSend(TX);
    const arg = signAndSendTransaction.mock.calls[0]?.[0] ?? {};
    expect(arg).toHaveProperty("user_id", "sdp:unscoped");
    expect(arg).toHaveProperty("transaction");
  });

  it("uses a fail-closed user_id on signAsFeePayer when no scoped identity is configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      client: fakeClient,
    });
    await adapter.signAsFeePayer(TX);
    const arg = signTransaction.mock.calls[0]?.[0] ?? {};
    expect(arg).toHaveProperty("user_id", "sdp:unscoped");
    expect(arg).toHaveProperty("transaction");
  });

  it("adds a Cloud Run service identity while preserving Kora API-key auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("header.e30.signature"))
      .mockResolvedValueOnce(
        Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: { signer_address: "FeePayer111" },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: { signed_transaction: "AQIDBA==" },
        })
      );
    const adapter = createKoraAdapter(
      {
        FEE_PAYMENT_PROVIDER: "kora",
        KORA_RPC_URL: "https://private-kora.example",
        KORA_API_KEY: "kora-api-key",
        KORA_CLOUD_RUN_AUDIENCE: "https://private-kora.example",
      },
      "sdp:v1:production:org:project:user:actor"
    );

    await adapter.signAsFeePayer(TX);

    const metadataUrl = fetchMock.mock.calls[0]?.[0];
    expect(metadataUrl).toBeInstanceOf(URL);
    expect(String(metadataUrl)).toContain("audience=https%3A%2F%2Fprivate-kora.example");
    const rpcRequest = fetchMock.mock.calls[2]?.[1];
    expect(rpcRequest?.headers).toMatchObject({
      Authorization: "Bearer header.e30.signature",
      "x-api-key": "kora-api-key",
    });
    expect(JSON.parse(String(rpcRequest?.body))).toMatchObject({
      method: "signTransaction",
      params: { user_id: "sdp:v1:production:org:project:user:actor" },
    });
  });

  it("rejects a Cloud Run identity audience that does not match the Kora origin", () => {
    expect(() =>
      createKoraAdapter(
        {
          FEE_PAYMENT_PROVIDER: "kora",
          KORA_RPC_URL: "https://kora-devnet.solana.com",
          KORA_CLOUD_RUN_AUDIENCE: "https://private-kora.example",
        },
        "sdp:v1:production:org:organization:api_key:key"
      )
    ).toThrow("KORA_RPC_URL must use HTTPS and match the KORA_CLOUD_RUN_AUDIENCE origin");
  });

  it("rejects sending a Cloud Run identity token over HTTP", () => {
    expect(
      () =>
        new KoraAdapter({
          rpcUrl: "http://private-kora.example",
          identityTokenAudience: "http://private-kora.example",
          userId: "sdp:v1:production:org:organization:api_key:key",
        })
    ).toThrow("KORA_RPC_URL must use HTTPS and match the KORA_CLOUD_RUN_AUDIENCE origin");
  });
});
