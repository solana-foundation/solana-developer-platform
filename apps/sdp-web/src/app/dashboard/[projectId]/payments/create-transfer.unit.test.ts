// @vitest-environment jsdom
/**
 * What `createTransfer` makes of each answer.
 *
 * A 202 is inside `response.ok` and is NOT a transfer: a wallet policy parked
 * the payment until somebody approves it. Reading it as a transfer is what
 * turned a held payment into "Transfer failed" and invited a second send.
 */

import { address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransfer, TransferRequestError, type Translate } from "./payments-workspace.data";

const t: Translate = (key) => key;

const SUBMISSION = {
  sourceCustodyWalletId: "cwlt_1",
  destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  token: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  amount: "250",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTransfer", () => {
  it("sends the idempotency key as a header, never in the body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { transfer: { id: "xfr_1", status: "confirmed" } } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await createTransfer(SUBMISSION, t, "key_1");

    expect(outcome).toEqual({ kind: "submitted", transfer: { id: "xfr_1", status: "confirmed" } });
    const init = fetchMock.mock.calls[0][1];
    expect(init).toBeDefined();
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("key_1");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("idempotencyKey");
  });

  it("carries no key header for a caller whose request is already single-shot", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { transfer: { id: "xfr_1", status: "confirmed" } } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await createTransfer({ ...SUBMISSION, transferId: "xfr_ramp" }, t, null);

    const init = fetchMock.mock.calls[0][1];
    expect(init).toBeDefined();
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBeNull();
    expect(JSON.parse(String(init?.body)).transferId).toBe("xfr_ramp");
  });

  it("reads a 202 as a payment held for approval, not a transfer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "SIGNING_PENDING",
              message: "Approval required",
              details: { approvalRequestId: "apr_1" },
            },
          },
          { status: 202 }
        )
      )
    );

    await expect(createTransfer(SUBMISSION, t, "key_1")).resolves.toEqual({
      kind: "approval_pending",
      approvalRequestId: "apr_1",
    });
  });

  // Nothing on an unreadable 202 says which approval holds the payment, and
  // pointing somebody at nothing is worse than saying it could not be read.
  it("refuses a 202 whose body names no approval request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: {} }, { status: 202 }))
    );

    await expect(createTransfer(SUBMISSION, t, "key_1")).rejects.toThrow(
      "DashboardPayments.workspace.transferMissing"
    );
  });

  it("refuses a success answer that carries no transfer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: {} }))
    );

    await expect(createTransfer(SUBMISSION, t, "key_1")).rejects.toThrow(
      "DashboardPayments.workspace.transferMissing"
    );
  });

  // The status decides the key's fate, so the error has to carry it.
  it("throws the API's message with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "over the limit" } }, { status: 422 }))
    );

    await expect(createTransfer(SUBMISSION, t, "key_1")).rejects.toMatchObject({
      name: "TransferRequestError",
      message: "over the limit",
      status: 422,
    });
    await expect(createTransfer(SUBMISSION, t, "key_1")).rejects.toBeInstanceOf(
      TransferRequestError
    );
  });
});
