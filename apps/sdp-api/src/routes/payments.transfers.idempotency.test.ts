import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { FeePaymentError } from "@sdp/payments/fee-payment";
import type * as solanaRpc from "@sdp/rpc/solana";
import { describe, expect, it, vi } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  createFeePaymentAdapterMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
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
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

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
    if (!stored.idempotency_fingerprint) throw new Error("missing idempotency fingerprint");
    expect(JSON.parse(stored.idempotency_fingerprint)).toHaveProperty(
      "custodyWalletId",
      TEST_CUSTODY_WALLET_ID
    );
    expect(signAndSendMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).toHaveBeenCalledOnce();
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
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

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
    expect(second.status).toBe(200);
    const secondBody = await readTransferResponse(second);
    expect(secondBody.data.transfer.status).toBe("failed");
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

    const [first, second] = await Promise.all([
      postTransfer(body, { idempotencyKey: "xfer-race-key" }),
      postTransfer(body, { idempotencyKey: "xfer-race-key" }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = await readTransferResponse(first);
    const secondJson = await readTransferResponse(second);
    expect(secondJson.data.transfer.id).toBe(firstJson.data.transfer.id);
    expect(await countTransferRows()).toBe(1);
    expect(sendTransactionMock).toHaveBeenCalledOnce();
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
    expect(conflict.status).toBe(409);
  });

  it("does not dedup when no Idempotency-Key is supplied", async () => {
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
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

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
          ReturnType<typeof solanaRpc.getRecentBlockhash>
        >["blockhash"],
        lastValidBlockHeight: 1000n,
      })
      .mockResolvedValueOnce({
        blockhash: "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3" as Awaited<
          ReturnType<typeof solanaRpc.getRecentBlockhash>
        >["blockhash"],
        lastValidBlockHeight: 1000n,
      });

    const a = await postTransfer(JSON.parse(body), {});
    const b = await postTransfer(JSON.parse(body), {});

    const aJson = await readTransferResponse(a);
    const bJson = await readTransferResponse(b);
    expect(bJson.data.transfer.id).not.toBe(aJson.data.transfer.id);
  });
});
