// @vitest-environment jsdom
/** A single transfer's idempotency key: stable across retry, retired once answered. */

import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Translate } from "./payments-workspace.data";
import {
  claimTransferIdempotencyKey,
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

beforeEach(() => {
  window.sessionStorage.clear();
  resetTransferIdempotencyStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

    const { transfer, fingerprint } = await sendTransferUnderKey(SUBMISSION, t);

    expect(transfer.id).toBe("xfr_1");
    // Retired: the next send of the same payment is a new payment.
    expect(claimTransferIdempotencyKey(fingerprint)).not.toBe(sentKey(fetchMock));
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
  it("joins simultaneous sends of one payment into a single request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { transfer: { id: "xfr_2", status: "confirmed" } } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const t: Translate = (key) => key;
    const outcomes = await Promise.all([
      sendTransferUnderKey(SUBMISSION, t),
      sendTransferUnderKey(SUBMISSION, t),
    ]);
    // Both callers report the ONE payment the key joined them into — each
    // anchored to the literal, so a divergence between them cannot hide.
    expect(outcomes[0]?.transfer).toEqual({ id: "xfr_2", status: "confirmed" });
    expect(outcomes[1]?.transfer).toEqual({ id: "xfr_2", status: "confirmed" });
    const sends = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("payments/transfers")
    );
    expect(sends).toHaveLength(1);
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
