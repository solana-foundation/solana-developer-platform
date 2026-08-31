import { address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTransfer,
  createTransferBatch,
  estimateTransferBatch,
} from "./payments-workspace.data";

const t = ((key: string) => key) as Parameters<typeof createTransfer>[1];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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
      t
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
    await createTransferBatch(request, t);

    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        sourceCustodyWalletId: "cwlt_1",
      });
      expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty("source");
    }
  });
});
