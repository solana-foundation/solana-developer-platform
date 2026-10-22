// @vitest-environment jsdom
/** A single transfer's idempotency key: stable across retry, retired once answered. */

import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MOVEMENT_POLL_INTERVAL_MS, resetMovementWatchesForTests } from "@/lib/dashboard-fetch";
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
  resetMovementWatchesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("transferRequestFingerprint", () => {
  // SOLA9-773: the API fingerprints the canonical amount, so a browser key
  // over the raw spelling minted a new key for `1` after a lost `1.0`.
  it("is one payment however the amount is spelled", () => {
    const fingerprint = (amount: string) => transferRequestFingerprint({ ...SUBMISSION, amount });
    expect(fingerprint("1.0")).toBe(fingerprint("1"));
    expect(fingerprint("01.50")).toBe(fingerprint("1.5"));
    expect(fingerprint("1.01")).not.toBe(fingerprint("1"));
    expect(fingerprint("10")).not.toBe(fingerprint("1"));
  });
});

describe("sendTransferUnderKey", () => {
  const t: Translate = (key) => key;

  it("resends a lost `1.0` as `1` under the same key, spelled as it is keyed", async () => {
    const fetchMock = vi
      .fn<typeof fetch>(async () =>
        Response.json({ data: { transfer: { id: "xfr_1", status: "confirmed" } } })
      )
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTransferUnderKey({ ...SUBMISSION, amount: "1.0" }, t)).rejects.toThrow(
      "Failed to fetch"
    );
    await sendTransferUnderKey({ ...SUBMISSION, amount: "1" }, t);

    const calls = fetchMock.mock.calls.map(([, init]) => ({
      key: new Headers(init?.headers).get("Idempotency-Key"),
      amount: z.object({ amount: z.string() }).parse(JSON.parse(String(init?.body))).amount,
    }));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(calls.map((call) => call.amount)).toEqual(["1", "1"]);
  });

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

  // APE-461: a 2xx retired the key while the transfer was still processing,
  // so the next identical press was a new payment under a new key. The API
  // replays the first answer verbatim, so the replay still says `processing`;
  // only a GET of the transfer can show it final and retire the key.
  it("keeps the key through a stale replay and retires it once a GET shows the transfer final", async () => {
    vi.useFakeTimers();
    let posts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "GET") {
        return Response.json({ data: { transfer: { id: "xfr_1", status: "finalized" } } });
      }
      posts += 1;
      return Response.json(
        { data: { transfer: { id: "xfr_1", status: "processing" } } },
        posts > 1 ? { headers: { "Idempotent-Replayed": "true" } } : undefined
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const keyOf = (call: number) =>
      new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get("Idempotency-Key");

    await sendTransferUnderKey(SUBMISSION, t);
    await sendTransferUnderKey(SUBMISSION, t);
    expect(keyOf(1)).toBe(keyOf(0));

    await vi.advanceTimersByTimeAsync(MOVEMENT_POLL_INTERVAL_MS);
    const read = fetchMock.mock.calls.find(([, init]) => init?.method === "GET");
    expect(read?.[0]).toBe("/api/dashboard/payments/transfers/xfr_1");

    await sendTransferUnderKey(SUBMISSION, t);
    expect(keyOf(fetchMock.mock.calls.length - 1)).not.toBe(keyOf(0));
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

  // Keegan (#2333): a 422 IDEMPOTENCY_KEY_REUSED retired the key, so the next
  // press minted a new one and could pay again while the first may have landed.
  it("keeps the key on IDEMPOTENCY_KEY_REUSED and says to restore the original or check", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: "IDEMPOTENCY_KEY_REUSED", message: "reused" } },
        { status: 422 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const fingerprint = transferRequestFingerprint(SUBMISSION);

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow(
      "Shared.idempotency.keyReusedRestoreOriginal"
    );

    expect(claimTransferIdempotencyKey(fingerprint)).toBe(sentKey(fetchMock));
  });

  // Greptile (#2333): a refusal whose body failed to download read as an
  // answered 422 with no code, which retired the key the payment ran under.
  it("keeps the key when a refusal's body fails to download", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("network error"));
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const fingerprint = transferRequestFingerprint(SUBMISSION);

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow();

    expect(claimTransferIdempotencyKey(fingerprint)).toBe(sentKey(fetchMock));
  });

  // A money movement never mints a fresh key while the original may have run:
  // the next press is answered under the same key.
  it("keeps the key on an unknown outcome and resends under it", async () => {
    const fetchMock = vi
      .fn<typeof fetch>(async () =>
        Response.json({ data: { transfer: { id: "xfr_1", status: "confirmed" } } })
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "use a new key" } },
          { status: 409 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow(
      "Shared.idempotency.outcomeUnknownCheckList"
    );
    await sendTransferUnderKey(SUBMISSION, t);

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key")
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  // Browser test (HOO-1918): the API recorded the transfer but the answer was
  // lost; a refusal after that settles nothing about the recorded transfer, so
  // the third press must replay it under the first key, not send a second one.
  it.each([
    ["a rate limit", 429],
    ["an expired session", 401],
  ])("keeps a lost attempt's key through %s", async (_label, status) => {
    const fetchMock = vi
      .fn<typeof fetch>(async () => Response.json({ error: { message: "refused" } }, { status }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow("Failed to fetch");
    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toMatchObject({ status });
    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow();

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key")
    );
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  // A key held in memory only is lost on reload, and a retry after the reload
  // would send the payment again under a fresh key.
  it("resends an earlier attempt's stored key even once storage refuses writes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { message: "unavailable" } }, { status: 503 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow();
    const unanswered = sentKey(fetchMock);

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toMatchObject({
        name: "TransferRequestError",
        status: 503,
      });
    } finally {
      setItem.mockRestore();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(
      unanswered
    );
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
