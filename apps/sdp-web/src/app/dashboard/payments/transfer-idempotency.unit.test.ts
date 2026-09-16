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
import {
  claimTransferIdempotencyKey,
  holdTransferIdempotencyKey,
  releaseSettledTransferHold,
  resetTransferIdempotencyStateForTests,
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
