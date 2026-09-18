// @vitest-environment jsdom
/**
 * The hold a policy approval puts on a single transfer's idempotency key.
 *
 * The key must outlive the person deciding, because the approval executor
 * replays the original request under it. It must NOT outlive the approval
 * itself: once that approval can no longer execute, the same payment typed
 * again is a new payment, and answering it with the old transfer sends nothing.
 */

import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Translate } from "./payments-workspace.data";
import {
  claimTransferIdempotencyKey,
  holdTransferIdempotencyKey,
  releaseSettledTransferHold,
  resetTransferIdempotencyStateForTests,
  sendTransferUnderKey,
  transferRequestFingerprint,
} from "./transfer-idempotency";

const SUBMISSION = {
  sourceCustodyWalletId: "cwlt_1",
  destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  token: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  amount: "250",
};

function approvalResponse(status: string, operationStatus?: string): Response {
  return Response.json({
    data: {
      approvalRequest: {
        id: "apr_1",
        status,
        ...(operationStatus === undefined ? {} : { operation: { status: operationStatus } }),
      },
    },
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetTransferIdempotencyStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("releaseSettledTransferHold", () => {
  it.each([
    ["rejected", undefined],
    ["canceled", undefined],
    ["expired", undefined],
    ["approved", "completed"],
    ["approved", "failed"],
  ])("frees the key once the approval is %s", async (status, operationStatus) => {
    const fingerprint = transferRequestFingerprint(SUBMISSION);
    const held = claimTransferIdempotencyKey(fingerprint);
    holdTransferIdempotencyKey(fingerprint, "apr_1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => approvalResponse(status, operationStatus))
    );

    await releaseSettledTransferHold(fingerprint);

    expect(claimTransferIdempotencyKey(fingerprint)).not.toBe(held);
  });

  it.each([
    ["the approval is still pending", () => approvalResponse("pending")],
    ["its operation is still executing", () => approvalResponse("approved", "executing")],
    ["its operation is still queued", () => approvalResponse("approved", "pending_approval")],
    ["its operation has only been created", () => approvalResponse("approved", "created")],
    ["its operation has only been evaluated", () => approvalResponse("approved", "evaluated")],
    ["its operation status is unknown", () => approvalResponse("approved", "unrecognized")],
    ["its operation is absent", () => approvalResponse("approved")],
  ])("keeps the key while %s", async (_label, respond) => {
    const fingerprint = transferRequestFingerprint(SUBMISSION);
    const held = claimTransferIdempotencyKey(fingerprint);
    holdTransferIdempotencyKey(fingerprint, "apr_1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond())
    );

    await releaseSettledTransferHold(fingerprint);

    expect(claimTransferIdempotencyKey(fingerprint)).toBe(held);
  });

  // Losing a key costs a second payment; keeping one costs a replay the API
  // reports. An unreadable answer takes the cheaper mistake.
  it.each([
    ["the read fails", () => Promise.reject(new Error("offline"))],
    ["the answer is not ok", async () => new Response("nope", { status: 500 })],
    ["the body cannot be read", async () => Response.json({ data: {} })],
  ])("keeps the key when %s", async (_label, respond) => {
    const fingerprint = transferRequestFingerprint(SUBMISSION);
    const held = claimTransferIdempotencyKey(fingerprint);
    holdTransferIdempotencyKey(fingerprint, "apr_1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond())
    );

    await releaseSettledTransferHold(fingerprint);

    expect(claimTransferIdempotencyKey(fingerprint)).toBe(held);
  });

  it("asks nothing when this payment holds no approval", async () => {
    const fingerprint = transferRequestFingerprint(SUBMISSION);
    const key = claimTransferIdempotencyKey(fingerprint);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await releaseSettledTransferHold(fingerprint);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(claimTransferIdempotencyKey(fingerprint)).toBe(key);
  });
});

describe("sendTransferUnderKey", () => {
  const t: Translate = (key) => key;

  /** The key the request actually carried. */
  function sentKey(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): string | null {
    const init = fetchMock.mock.calls[0]?.[1];
    return new Headers(init?.headers).get("Idempotency-Key");
  }

  it("retires the key once the API records the transfer", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { transfer: { id: "xfr_1", status: "confirmed" } } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { outcome, fingerprint } = await sendTransferUnderKey(SUBMISSION, t);

    expect(outcome.kind).toBe("submitted");
    // Retired: the next send of the same payment is a new payment.
    expect(claimTransferIdempotencyKey(fingerprint)).not.toBe(sentKey(fetchMock));
  });

  it("keeps the key an approval is holding, so a retry joins that payment", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
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
    );
    vi.stubGlobal("fetch", fetchMock);

    const { outcome, fingerprint } = await sendTransferUnderKey(SUBMISSION, t);

    expect(outcome).toEqual({ kind: "approval_pending", approvalRequestId: "apr_1" });
    expect(claimTransferIdempotencyKey(fingerprint)).toBe(sentKey(fetchMock));
  });

  // A refusal moved nothing, so the key is free. A lost answer may have
  // recorded the payment, so it is not.
  it.each([
    ["a 4xx refusal frees it", 422, false],
    ["a key conflict keeps it", 409, true],
    ["a 5xx keeps it", 503, true],
  ])("%s", async (_label, status, kept) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { message: "refused" } }, { status })
    );
    vi.stubGlobal("fetch", fetchMock);
    const fingerprint = transferRequestFingerprint(SUBMISSION);

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow();

    expect(claimTransferIdempotencyKey(fingerprint) === sentKey(fetchMock)).toBe(kept);
  });
});

describe("concurrent transfer submissions", () => {
  it("joins sends while a completed approval is being released", async () => {
    const fingerprint = transferRequestFingerprint(SUBMISSION);
    const oldKey = claimTransferIdempotencyKey(fingerprint);
    holdTransferIdempotencyKey(fingerprint, "apr_1");
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("approval-requests")
        ? approvalResponse("approved", "completed")
        : Response.json({ data: { transfer: { id: "xfr_2", status: "confirmed" } } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const t: Translate = (key) => key;
    const outcomes = await Promise.all([
      sendTransferUnderKey(SUBMISSION, t),
      sendTransferUnderKey(SUBMISSION, t),
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    const sends = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("payments/transfers")
    );
    expect(sends).toHaveLength(1);
    expect(new Headers(sends[0][1]?.headers).get("Idempotency-Key")).not.toBe(oldKey);
  });
});

describe("provider session retries", () => {
  it("retains a successful payment key across an unauthorized callback retry", async () => {
    let unauthorized = false;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      unauthorized
        ? Response.json({ error: { message: "Session expired" } }, { status: 401 })
        : Response.json({ data: { transfer: { id: "xfr_1", status: "confirmed" } } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const t: Translate = (key) => key;
    await sendTransferUnderKey(SUBMISSION, t, "session_1");
    unauthorized = true;
    await expect(sendTransferUnderKey(SUBMISSION, t, "session_1")).rejects.toThrow(
      "Session expired"
    );
    unauthorized = false;
    resetTransferIdempotencyStateForTests();
    await sendTransferUnderKey(SUBMISSION, t, "session_1");
    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key")
    );
    expect(keys[0]).toBeTruthy();
    expect(new Set(keys).size).toBe(1);
  });

  it("keeps one payment key after success and separates later sessions", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: { transfer: { id: "xfr_1", status: "confirmed", signature: "sig_1" } },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const t: Translate = (key) => key;
    await sendTransferUnderKey(SUBMISSION, t, "session_1");
    resetTransferIdempotencyStateForTests();
    await sendTransferUnderKey(SUBMISSION, t, "session_1");
    await sendTransferUnderKey(SUBMISSION, t, "session_2");
    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key")
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
