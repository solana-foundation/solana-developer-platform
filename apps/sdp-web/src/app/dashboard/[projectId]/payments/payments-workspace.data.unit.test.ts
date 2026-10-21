import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWindowPathname } from "@/test/window-location";
import {
  createTransfer,
  createTransferBatch,
  estimateTransferBatch,
  fetchTransferById,
  fetchTransfers,
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

  it("sends the exact custody wallet id, the tab's Project, and the caller's key or one per action", async () => {
    const fetch = vi.fn().mockImplementation(async () =>
      jsonResponse({
        data: {
          transfer: {
            id: "trf_1",
            custodyWalletId: "cwlt_1",
            rampsMemo: {},
            status: "pending",
            signature: null,
          },
        },
      })
    );
    vi.stubGlobal("fetch", fetch);

    await createTransfer({ ...transferInput, transferId: "xfr_1" }, t, {
      value: "idem_transfer_1",
      persisted: true,
    });
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
    // A caller without its own key still gets one per user action (HOO-1918).
    const unkeyedHeaders = new Headers(unkeyed);
    expect(unkeyedHeaders.get("x-project-id")).toBe("prj_test_sandbox");
    expect(unkeyedHeaders.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([undefined, null, "cwlt_alias"])(
    "refuses a created transfer whose exact source is %j",
    async (custodyWalletId) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            data: {
              transfer: {
                id: "trf_1",
                custodyWalletId,
                providerWalletId: "same-provider-reference",
                status: "pending",
                signature: null,
              },
            },
          })
        )
      );

      await expect(
        createTransfer(transferInput, t, { value: "idem_transfer_1", persisted: true })
      ).rejects.toThrow("DashboardPayments.workspace.transferMissing");
    }
  );

  it("accepts a created transfer with exact identity without ramps memo metadata", async () => {
    const transfer = {
      id: "trf_1",
      custodyWalletId: "cwlt_1",
      status: "pending",
      signature: null,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { transfer } })));

    expect(
      await createTransfer(transferInput, t, { value: "idem_transfer_1", persisted: true })
    ).toEqual(transfer);
  });

  it("refuses a successful transfer with an invalid result status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            transfer: { id: "trf_1", custodyWalletId: "cwlt_1", status: 42, signature: null },
          },
        })
      )
    );

    await expect(
      createTransfer(transferInput, t, { value: "idem_transfer_1", persisted: true })
    ).rejects.toThrow("DashboardPayments.workspace.transferMissing");
  });

  it("keeps provider metadata opaque when creating a transfer with the exact source", async () => {
    const transfer = {
      id: "trf_1",
      custodyWalletId: "cwlt_1",
      providerWalletId: "retained provider reference",
      status: "pending",
      signature: null,
      rampsMemo: ["opaque metadata"],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { transfer } })));

    expect(
      await createTransfer(transferInput, t, { value: "idem_transfer_1", persisted: true })
    ).toEqual(transfer);
  });

  it("reads exact and nullable history without requiring provider metadata", async () => {
    const exact = { id: "trf_1", custodyWalletId: "cwlt_1", rampsMemo: {} };
    const legacy = { id: "trf_legacy", custodyWalletId: null, rampsMemo: {} };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [exact, legacy] }))
        .mockResolvedValueOnce(jsonResponse({ data: { transfer: legacy } }))
    );

    expect(await fetchTransfers({ pageSize: 10 }, t)).toEqual([exact, legacy]);
    expect(await fetchTransferById({ transferId: "trf_legacy" }, t)).toEqual(legacy);
  });

  it("reads exact and nullable transfers without ramps memo metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            { id: "trf_1", custodyWalletId: "cwlt_1" },
            { id: "trf_legacy", custodyWalletId: null },
          ],
        })
      )
    );

    expect(await fetchTransfers({ pageSize: 10 }, t)).toEqual([
      { id: "trf_1", custodyWalletId: "cwlt_1" },
      { id: "trf_legacy", custodyWalletId: null },
    ]);
  });

  it.each(["cwlt_1", null])(
    "reads transfer detail without ramps memo metadata for source %s",
    async (custodyWalletId) => {
      const transfer = { id: "trf_1", custodyWalletId };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { transfer } })));

      expect(await fetchTransferById({ transferId: "trf_1" }, t)).toEqual(transfer);
    }
  );

  it("keeps transfer list reads without new identity validation", async () => {
    const transfers = [{ id: "trf_1" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: transfers })));

    expect(await fetchTransfers({ pageSize: 10 }, t)).toEqual(transfers);
  });

  it("keeps transfer detail reads without new identity validation", async () => {
    const transfer = { id: "trf_1" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { transfer } })));

    expect(await fetchTransferById({ transferId: "trf_1" }, t)).toEqual(transfer);
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

    await expect(
      createTransfer(transferInput, t, { value: "idem_transfer_1", persisted: true })
    ).rejects.toThrow("DashboardPayments.workspace.transferMissing");
  });

  it("carries the status of a refusal so the caller can decide the key's fate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Insufficient balance" } }, 422))
    );

    const refusal = await createTransfer(transferInput, t, {
      value: "idem_transfer_1",
      persisted: true,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TransferRequestError);
    expect(refusal).toMatchObject({ status: 422, message: "Insufficient balance" });
  });

  it("uses the exact custody wallet id for batch estimate and create", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { estimate: { transactionCount: 1 } } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            batch: {
              id: "batch_1",
              sourceCustodyWalletId: "cwlt_1",
              status: "pending",
              recipientCount: 0,
              transactionCount: 0,
            },
            recipients: [],
            transfers: [],
          },
        })
      );
    vi.stubGlobal("fetch", fetch);
    const request = {
      sourceCustodyWalletId: "cwlt_1",
      token: "mint",
      recipients: [{ counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "1" }],
    };

    await estimateTransferBatch(request, t);
    await createTransferBatch(request, t, { value: "idem_batch_1", persisted: true });

    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        sourceCustodyWalletId: "cwlt_1",
      });
      expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty("source");
    }
  });

  it("accepts batch transfers with exact identity and opaque provider metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            batch: {
              id: "batch_1",
              sourceCustodyWalletId: "cwlt_1",
              sourceProviderWalletId: "retained provider reference",
              status: "confirmed",
              recipientCount: 0,
              transactionCount: 1,
            },
            recipients: [],
            transfers: [
              {
                id: "trf_chunk",
                custodyWalletId: "cwlt_1",
                providerWalletId: "retained provider reference",
                status: "confirmed",
                signature: "sig_1",
              },
            ],
          },
        })
      )
    );

    expect(
      await createTransferBatch(
        { sourceCustodyWalletId: "cwlt_1", token: "mint", recipients: [] },
        t,
        { value: "idem_batch_1", persisted: true }
      )
    ).toEqual({
      batch: {
        id: "batch_1",
        sourceCustodyWalletId: "cwlt_1",
        sourceProviderWalletId: "retained provider reference",
        status: "confirmed",
        recipientCount: 0,
        transactionCount: 1,
      },
      recipients: [],
      transfers: [
        {
          id: "trf_chunk",
          custodyWalletId: "cwlt_1",
          providerWalletId: "retained provider reference",
          status: "confirmed",
          signature: "sig_1",
        },
      ],
    });
  });

  it("refuses a successful batch with an invalid recipient amount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            batch: {
              id: "batch_1",
              sourceCustodyWalletId: "cwlt_1",
              status: "confirmed",
              recipientCount: 1,
              transactionCount: 1,
            },
            recipients: [
              {
                id: "recipient_1",
                transferId: "trf_chunk",
                counterpartyAccountId: "acct_1",
                amount: 42,
                destination: "destination",
                status: "confirmed",
              },
            ],
            transfers: [
              {
                id: "trf_chunk",
                custodyWalletId: "cwlt_1",
                status: "confirmed",
                signature: "sig_1",
              },
            ],
          },
        })
      )
    );

    await expect(
      createTransferBatch({ sourceCustodyWalletId: "cwlt_1", token: "mint", recipients: [] }, t, {
        value: "idem_batch_1",
        persisted: true,
      })
    ).rejects.toThrow("DashboardPayments.workspace.batchTransferMissing");
  });

  it.each([
    { batchSource: undefined, chunkSource: "cwlt_1" },
    { batchSource: null, chunkSource: "cwlt_1" },
    { batchSource: "cwlt_alias", chunkSource: "cwlt_1" },
    { batchSource: "cwlt_1", chunkSource: null },
    { batchSource: "cwlt_1", chunkSource: "cwlt_alias" },
  ])(
    "refuses a batch or chunk with another exact source: %j",
    async ({ batchSource, chunkSource }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            data: {
              batch: {
                id: "batch_1",
                sourceCustodyWalletId: batchSource,
                sourceProviderWalletId: "shared-provider-reference",
                status: "confirmed",
                recipientCount: 0,
                transactionCount: 1,
              },
              recipients: [],
              transfers: [
                {
                  id: "trf_chunk",
                  custodyWalletId: chunkSource,
                  providerWalletId: "shared-provider-reference",
                  status: "confirmed",
                  signature: "sig_1",
                },
              ],
            },
          })
        )
      );

      await expect(
        createTransferBatch({ sourceCustodyWalletId: "cwlt_1", token: "mint", recipients: [] }, t, {
          value: "idem_batch_1",
          persisted: true,
        })
      ).rejects.toThrow("DashboardPayments.workspace.batchTransferMissing");
    }
  );
});
