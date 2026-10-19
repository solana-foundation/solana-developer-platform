import type { createFeePaymentAdapter } from "@sdp/fee-payment";
import { FeePaymentError } from "@sdp/fee-payment/port";
import type { getRecentBlockhash } from "@sdp/rpc/solana";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  TEST_USER,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  postTransfer,
  readTransferResponse,
  readTransferRow,
} from "@/test/helpers/payments-transfers";
import { fullySignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

describe("Payments routes — transfer idempotency", () => {
  installPaymentsRouteTestHooks();
  installClusterRpcStub();
  it("replays a transfer when the same Idempotency-Key + body is retried", async () => {
    const signAndSendMock = vi
      .fn()
      .mockResolvedValue(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: TEST_MOCK_FEE_PAYER,
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof createFeePaymentAdapter>);

    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "xfer-key-1",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    });

    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    const second = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = await readTransferResponse(first);
    const secondJson = await readTransferResponse(second);
    expect(secondJson.data.transfer.id).toBe(firstJson.data.transfer.id);
    const stored = await readTransferRow(firstJson.data.transfer.id);
    expect(stored.custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
    // The row records the key layer's fingerprint, which replayFromRecord compares.
    const keyRecord = await getDb(env)
      .prepare("SELECT fingerprint FROM idempotency_keys WHERE idempotency_key = ?")
      .bind("xfer-key-1")
      .first<{ fingerprint: string }>();
    expect(stored.idempotency_fingerprint).toBe(keyRecord?.fingerprint);
    expect(signAndSendMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });

  it("binds the domain row to its credential: past the key record, the same credential replays and another runs as new", async () => {
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: TEST_MOCK_FEE_PAYER,
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: vi.fn(),
    } as ReturnType<typeof createFeePaymentAdapter>);
    const otherKey = {
      id: "key_payments_other",
      raw: "sk_test_payments_other",
      prefix: "sk_test_oth",
    };
    await seedProjectApiKey(getDb(env), env, {
      key: otherKey,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      grants: ALL_API_KEY_GRANTS,
    });
    const body = {
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    };
    const expireKeyRecords = () =>
      getDb(env).execute(
        "UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE idempotency_key = ?",
        ["xfer-shared-key"]
      );

    const first = await postTransfer(body, { idempotencyKey: "xfer-shared-key" });
    expect(first.status).toBe(200);
    const firstId = (await readTransferResponse(first)).data.transfer.id;
    await expireKeyRecords();

    const sameCredential = await postTransfer(body, { idempotencyKey: "xfer-shared-key" });
    expect(sameCredential.status).toBe(200);
    expect((await readTransferResponse(sameCredential)).data.transfer.id).toBe(firstId);
    expect(await countTransferRows()).toBe(1);
    await expireKeyRecords();

    // A new transfer signs new bytes: a fresh blockhash keeps its signature distinct.
    getRecentBlockhashMock.mockResolvedValue({
      blockhash: TEST_SOLANA_ADDRESSES.wallet3 as Awaited<
        ReturnType<typeof getRecentBlockhash>
      >["blockhash"],
      lastValidBlockHeight: 1000n,
    });
    const otherCredential = await postTransfer(body, {
      idempotencyKey: "xfer-shared-key",
      auth: { kind: "api_key", raw: otherKey.raw },
    });
    expect(otherCredential.status).toBe(200);
    expect((await readTransferResponse(otherCredential)).data.transfer.id).not.toBe(firstId);
    expect(await countTransferRows()).toBe(2);
  });

  it("replays a failed transfer on retry without submitting again", async () => {
    const signAsFeePayerMock = vi
      .fn()
      .mockRejectedValue(new FeePaymentError("insufficient balance", "INSUFFICIENT_BALANCE"));
    const signAndSendMock = vi.fn();
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: TEST_MOCK_FEE_PAYER,
      }),
      signAsFeePayer: signAsFeePayerMock,
      signAndSend: signAndSendMock,
    } as ReturnType<typeof createFeePaymentAdapter>);

    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "failed-retry-key",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.001",
    });

    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    const second = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });

    expect(first.status).toBeGreaterThanOrEqual(400);
    // The retry is answered with the same error as the request that failed the row
    // (HOO-1918), never a 200 for the failed row.
    expect(second.status).toBe(first.status);
    const [firstError, secondError] = (await Promise.all([first.json(), second.json()])) as {
      error: { code: string };
    }[];
    expect(secondError?.error.code).toBe(firstError?.error.code);
    expect(signAsFeePayerMock).toHaveBeenCalledOnce();
    expect(signAndSendMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it("executes once when two requests race on the same Idempotency-Key", async () => {
    const body = {
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    };

    const responses = await Promise.all([
      postTransfer(body, { idempotencyKey: "xfer-race-key" }),
      postTransfer(body, { idempotencyKey: "xfer-race-key" }),
    ]);

    // The shared step lets one run; the other is told the key is in flight
    // (HOO-1918) and its retry replays the winner's answer.
    const winner = responses.find((response) => response.status === 200);
    const loser = responses.find((response) => response.status === 409);
    if (!winner || !loser) {
      throw new Error(`expected one 200 and one 409, got ${responses.map((r) => r.status)}`);
    }
    expect(((await loser.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_IN_FLIGHT"
    );
    const retry = await postTransfer(body, { idempotencyKey: "xfer-race-key" });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    const winnerJson = await readTransferResponse(winner);
    expect((await readTransferResponse(retry)).data.transfer.id).toBe(winnerJson.data.transfer.id);
    expect(await countTransferRows()).toBe(1);
    expect(sendTransactionMock).toHaveBeenCalledOnce();
  });

  it("fingerprints the amount canonically, so 1.0 and 1 are one transfer", async () => {
    const body = {
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
    };

    const first = await postTransfer(
      { ...body, amount: "1.0" },
      { idempotencyKey: "xfer-spelling" }
    );
    expect(first.status).toBe(200);
    const respelled = await postTransfer(
      { ...body, amount: "1" },
      { idempotencyKey: "xfer-spelling" }
    );

    expect(respelled.status).toBe(200);
    expect(respelled.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readTransferResponse(respelled)).data.transfer.id).toBe(
      (await readTransferResponse(first)).data.transfer.id
    );
    expect(await countTransferRows()).toBe(1);
  });

  it("refuses an unknown ramp transferId before claiming the key", async () => {
    const response = await postTransfer(
      {
        transferId: "ptx_missing_ramp_deposit",
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      { idempotencyKey: "xfer-missing-ramp" }
    );

    expect(response.status).toBe(404);
    // Refused before the claim: no 404 is stored under the key for 24 hours.
    const keys = await getDb(env)
      .prepare("SELECT COUNT(*)::integer AS count FROM idempotency_keys WHERE idempotency_key = ?")
      .bind("xfer-missing-ramp")
      .first<{ count: number }>();
    expect(keys).toEqual({ count: 0 });
  });

  it("refuses a transfer without an Idempotency-Key before anything runs", async () => {
    const response = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      { idempotencyKey: null }
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED"
    );
    expect(await countTransferRows()).toBe(0);
  });

  it("rejects the same Idempotency-Key with a different body", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "xfer-key-2",
    };

    const first = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      },
      { idempotencyKey: headers["Idempotency-Key"] }
    );
    expect(first.status).toBe(200);

    const conflict = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "2",
      },
      { idempotencyKey: headers["Idempotency-Key"] }
    );
    expect(conflict.status).toBe(422);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED"
    );
  });

  it("does not dedup two requests under different Idempotency-Keys", async () => {
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: TEST_MOCK_FEE_PAYER,
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof createFeePaymentAdapter>);

    const _headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    });
    getRecentBlockhashMock
      .mockResolvedValueOnce({
        blockhash: "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2" as Awaited<
          ReturnType<typeof getRecentBlockhash>
        >["blockhash"],
        lastValidBlockHeight: 1000n,
      })
      .mockResolvedValueOnce({
        blockhash: "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3" as Awaited<
          ReturnType<typeof getRecentBlockhash>
        >["blockhash"],
        lastValidBlockHeight: 1000n,
      });

    const a = await postTransfer(JSON.parse(body), {});
    const b = await postTransfer(JSON.parse(body), {});

    const aJson = await readTransferResponse(a);
    const bJson = await readTransferResponse(b);
    expect(bJson.data.transfer.id).not.toBe(aJson.data.transfer.id);
  });

  // HOO-2099: the custody signer refuses a wallet outside a selected key's
  // scope; authorize refuses it first, before the key is claimed, so the
  // refusal writes no transfer row and no Idempotency-Key, and the same key
  // runs once the scope allows the wallet.
  it("refuses a transfer from a wallet outside the key's scope before writing anything", async () => {
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: TEST_MOCK_FEE_PAYER,
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      signAndSend: vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        ),
    } as ReturnType<typeof createFeePaymentAdapter>);
    await seedCachedKey({ walletScope: "selected", walletIds: [] });
    const body = {
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "1",
    };

    const refused = await postTransfer(body, { idempotencyKey: "xfer-out-of-scope" });

    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      error: { details: { reason: "wallet_out_of_scope" } },
    });
    expect(await countTransferRows()).toBe(0);
    const keys = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM idempotency_keys WHERE idempotency_key = ?")
      .bind("xfer-out-of-scope")
      .first<{ count: number }>();
    expect(keys).toEqual({ count: 0 });

    await seedCachedKey({ walletIds: [TEST_CUSTODY_WALLET_ID] });
    expect((await postTransfer(body, { idempotencyKey: "xfer-out-of-scope" })).status).toBe(200);
  });
});
