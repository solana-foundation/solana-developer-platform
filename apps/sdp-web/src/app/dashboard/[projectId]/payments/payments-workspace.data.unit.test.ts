import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { setWindowPathname } from "@/test/window-location";
import {
  createTransfer,
  createTransferBatch,
  estimateTransferBatch,
  fetchWalletBalances,
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
  beforeEach(() => setWindowPathname("/dashboard/prj_test_sandbox/payments/pay"));
  afterEach(() => vi.unstubAllGlobals());

  const transferInput = {
    sourceCustodyWalletId: "cwlt_1",
    destination: "destination",
    token: address("So11111111111111111111111111111111111111112"),
    amount: "1",
  };

  it("sends the exact custody wallet id, the tab's Project, and a key only when there is one", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ data: { transfer: { id: "trf_1", status: "pending", signature: null } } })
      );
    vi.stubGlobal("fetch", fetch);

    await createTransfer({ ...transferInput, transferId: "xfr_1" }, t, "idem_transfer_1");
    await createTransfer(transferInput, t, null);

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ ...transferInput, transferId: "xfr_1" });

    const [keyed, unkeyed] = fetch.mock.calls.map(([, init]) => (init as RequestInit).headers);
    expect(keyed).toEqual(
      new Headers({
        "Content-Type": "application/json",
        "Idempotency-Key": "idem_transfer_1",
        "x-project-id": "prj_test_sandbox",
      })
    );
    expect(unkeyed).toEqual(
      new Headers({ "Content-Type": "application/json", "x-project-id": "prj_test_sandbox" })
    );
  });

  it("treats a 202 SIGNING_PENDING body like any other unexpected response", async () => {
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

    await expect(createTransfer(transferInput, t, "idem_transfer_1")).rejects.toThrow(
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

describe("Payments exact wallet balance reads", () => {
  beforeEach(() => setWindowPathname("/dashboard/prj_test_sandbox/payments/pay"));
  afterEach(() => vi.unstubAllGlobals());

  it("preserves a successful exact zero response without requiring provider identity", async () => {
    const walletBalances = { custodyWalletId: "cwlt_1", address: "address", balances: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { walletBalances } }))
    );

    await expect(fetchWalletBalances("cwlt_1", t)).resolves.toEqual(walletBalances);
  });

  it("rejects a successful response identifying a different exact wallet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            walletBalances: { custodyWalletId: "cwlt_other", address: "address", balances: [] },
          },
        })
      )
    );

    await expect(fetchWalletBalances("cwlt_1", t)).rejects.toThrow(
      "Wallet balance response did not identify the requested wallet."
    );
  });

  it("preserves a validated API refusal message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "RPC unavailable" } }, 503))
    );

    await expect(fetchWalletBalances("cwlt_1", t)).rejects.toThrow("RPC unavailable");
  });

  it("rejects a malformed nested API error instead of substituting a message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: 42 } }, 503))
    );

    await expect(fetchWalletBalances("cwlt_1", t)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects malformed JSON instead of replacing the response with an empty envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { headers: { "Content-Type": "application/json" } }))
    );

    await expect(fetchWalletBalances("cwlt_1", t)).rejects.toBeInstanceOf(SyntaxError);
  });
});
