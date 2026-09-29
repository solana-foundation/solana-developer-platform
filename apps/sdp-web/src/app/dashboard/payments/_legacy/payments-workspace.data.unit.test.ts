import { address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTransfer,
  createTransferBatch,
  estimateTransferBatch,
  TransferRequestError,
} from "./payments-workspace.data";

const t = ((key: string) => key) as Parameters<typeof createTransfer>[1];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Payments write requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a transfer with the exact custody wallet id", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { transfer: { id: "trf_1", status: "pending", signature: null } } })
      );
    vi.stubGlobal("fetch", fetch);

    await createTransfer(
      {
        transferId: "xfr_1",
        sourceCustodyWalletId: "cwlt_1",
        destination: "destination",
        token: address("So11111111111111111111111111111111111111112"),
        amount: "1",
      },
      t,
      null
    );

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      transferId: "xfr_1",
      sourceCustodyWalletId: "cwlt_1",
      destination: "destination",
      token: "So11111111111111111111111111111111111111112",
      amount: "1",
    });
  });

  const transferInput = {
    sourceCustodyWalletId: "cwlt_1",
    destination: "destination",
    token: address("So11111111111111111111111111111111111111112"),
    amount: "1",
  };

  it("sends the idempotency key as a header only when there is one", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ data: { transfer: { id: "trf_1", status: "pending", signature: null } } })
      );
    vi.stubGlobal("fetch", fetch);

    await createTransfer(transferInput, t, "idem_transfer_1");
    await createTransfer(transferInput, t, null);

    const [keyed, unkeyed] = fetch.mock.calls.map(([, init]) => (init as RequestInit).headers);
    expect(keyed).toEqual({
      "Content-Type": "application/json",
      "Idempotency-Key": "idem_transfer_1",
    });
    expect(unkeyed).toEqual({ "Content-Type": "application/json" });
  });

  it("reads a policy hold as a pending approval, not a failed transfer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "SIGNING_PENDING",
              message: "Approval required",
              details: { approvalRequestId: "apr_1" },
            },
          },
          202
        )
      )
    );

    await expect(createTransfer(transferInput, t, "idem_transfer_1")).resolves.toEqual({
      kind: "approval_pending",
      approvalRequestId: "apr_1",
    });
  });

  it("refuses a 202 that names no approval request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: {} }, 202)));

    await expect(createTransfer(transferInput, t, null)).rejects.toThrow(
      "DashboardPayments.workspace.transferMissing"
    );
  });

  it("carries the status of a refusal so the caller can decide the key's fate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Insufficient balance" } }, 422))
    );

    const refusal = await createTransfer(transferInput, t, "idem_transfer_1").catch(
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(TransferRequestError);
    expect(refusal).toMatchObject({ status: 422, message: "Insufficient balance" });
  });

  it("uses the exact custody wallet id for batch estimate and create", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { estimate: { transactionCount: 1 } } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { batch: { id: "batch_1" }, recipients: [], transfers: [] },
        })
      );
    vi.stubGlobal("fetch", fetch);
    const request = {
      sourceCustodyWalletId: "cwlt_1",
      token: "mint",
      recipients: [{ counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "1" }],
    };

    await estimateTransferBatch(request, t);
    await createTransferBatch(request, t, "idem_batch_1");

    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        sourceCustodyWalletId: "cwlt_1",
      });
      expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty("source");
    }
  });
});
