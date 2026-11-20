// @vitest-environment jsdom
/**
 * A single transfer's idempotency key: the same key on every retry of one payment until an
 * answer settles it, and a new key for a different payment.
 */

import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { MOVEMENT_POLL_INTERVAL_MS, resetMovementWatchesForTests } from "@/lib/dashboard-fetch";
import { KEPT_KEY_WINDOW_MS } from "@/lib/idempotency-key-store";
import { sentDashboardRequests, stubDashboardFetch } from "@/test/dashboard-fetch";
import { required } from "@/test/required";
import type { Translate } from "./payments-workspace.data";
import {
  resetTransferIdempotencyStateForTests,
  sendTransferUnderKey,
} from "./transfer-idempotency";

const SUBMISSION = {
  sourceCustodyWalletId: "cwlt_1",
  destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  token: address(WELL_KNOWN_TOKENS.USDC.mints.devnet.address),
  amount: "250",
};

const t: Translate = (key) => key;

const confirmed = () => Response.json({ data: { transfer: { id: "xfr_1", status: "confirmed" } } });

/** The Idempotency-Key each transfer send carried, in order; a send without one fails the test. */
function sentKeys(fetchMock: Mock<typeof fetch>): string[] {
  return sentDashboardRequests(fetchMock)
    .filter((request) => request.method === "POST")
    .map((request) => required(request.idempotencyKey));
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetTransferIdempotencyStateForTests();
  resetMovementWatchesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sendTransferUnderKey", () => {
  // SOLA9-773: the API fingerprints the canonical amount, so a key over the raw
  // spelling minted a new key for `1` after a lost `1.0`.
  it("resends a lost `1.0` as `1` under the same key, spelled as it is keyed", async () => {
    const fetchMock = stubDashboardFetch(confirmed).mockRejectedValueOnce(
      new TypeError("Failed to fetch")
    );

    await expect(sendTransferUnderKey({ ...SUBMISSION, amount: "1.0" }, t)).rejects.toThrow(
      "Failed to fetch"
    );
    await sendTransferUnderKey({ ...SUBMISSION, amount: "1" }, t);

    expect(sentDashboardRequests(fetchMock).map((request) => request.body)).toEqual([
      { ...SUBMISSION, amount: "1" },
      { ...SUBMISSION, amount: "1" },
    ]);
    const keys = sentKeys(fetchMock);
    expect(keys[1]).toBe(keys[0]);
  });

  it("sends a different amount, destination or memo under a new key", async () => {
    const fetchMock = stubDashboardFetch(() =>
      Response.json({ error: { message: "unavailable" } }, { status: 503 })
    );

    for (const submission of [
      SUBMISSION,
      { ...SUBMISSION, amount: "251" },
      { ...SUBMISSION, destination: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      { ...SUBMISSION, memo: "invoice 7" },
    ]) {
      await expect(sendTransferUnderKey(submission, t)).rejects.toThrow("unavailable");
    }

    expect(new Set(sentKeys(fetchMock)).size).toBe(4);
  });

  // Naming the contact account pays the same address: a retry that only changes
  // it must reuse the key, so the API refuses it (422) instead of paying twice.
  it("resends under the same key when a retry only adds the contact account", async () => {
    const fetchMock = stubDashboardFetch(confirmed).mockRejectedValueOnce(
      new TypeError("Failed to fetch")
    );

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow("Failed to fetch");
    await sendTransferUnderKey({ ...SUBMISSION, counterpartyAccountId: "cpacct_1" }, t);

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  // The API answers a transfer's key from the transfer row after its 24-hour
  // key record lapses, so the old key replays the first transfer; a new key
  // would pay again.
  it("resends a kept key however old it is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = stubDashboardFetch(confirmed).mockRejectedValueOnce(
      new TypeError("Failed to fetch")
    );

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow("Failed to fetch");
    vi.setSystemTime(Date.now() + KEPT_KEY_WINDOW_MS);
    await sendTransferUnderKey(SUBMISSION, t);

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("sends the same payment again under a new key once the API answers it final", async () => {
    const fetchMock = stubDashboardFetch(confirmed);

    const { transfer } = await sendTransferUnderKey(SUBMISSION, t);
    await sendTransferUnderKey(SUBMISSION, t);

    expect(transfer).toEqual({ id: "xfr_1", status: "confirmed" });
    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  // APE-461: a 2xx retired the key while the transfer was still processing,
  // so the next identical press was a new payment under a new key. The API
  // replays the first answer verbatim, so the replay still says `processing`;
  // only a GET of the transfer can show it final and retire the key.
  it("keeps the key through a stale replay and retires it once a GET shows the transfer final", async () => {
    vi.useFakeTimers();
    let posts = 0;
    const fetchMock = stubDashboardFetch(({ method }) => {
      if (method === "GET") {
        return Response.json({ data: { transfer: { id: "xfr_1", status: "finalized" } } });
      }
      posts += 1;
      return Response.json(
        { data: { transfer: { id: "xfr_1", status: "processing" } } },
        posts > 1 ? { headers: { "Idempotent-Replayed": "true" } } : undefined
      );
    });

    await sendTransferUnderKey(SUBMISSION, t);
    await sendTransferUnderKey(SUBMISSION, t);
    expect(sentKeys(fetchMock)[1]).toBe(sentKeys(fetchMock)[0]);

    await vi.advanceTimersByTimeAsync(MOVEMENT_POLL_INTERVAL_MS);
    expect(
      sentDashboardRequests(fetchMock)
        .filter((request) => request.method === "GET")
        .map((request) => request.path)
    ).toEqual(["/api/dashboard/payments/transfers/xfr_1"]);

    await sendTransferUnderKey(SUBMISSION, t);
    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
  });

  // A refusal the API recorded moved nothing, so the key is free. Any other
  // refusal settles nothing about a payment the lost first attempt may have
  // recorded (HOO-1918), so the next press is answered under the same key.
  it.each([
    ["a 422 refusal frees it", 422, false, false],
    ["a replayed refusal frees it", 503, true, false],
    ["a 409 keeps it", 409, false, true],
    ["a rate limit keeps it", 429, false, true],
    ["an expired session keeps it", 401, false, true],
    ["a 5xx keeps it", 503, false, true],
  ])("after a lost answer, %s", async (_label, status, replayed, kept) => {
    const fetchMock = stubDashboardFetch(() =>
      Response.json(
        { error: { message: "refused" } },
        { status, headers: replayed ? { "Idempotent-Replayed": "true" } : undefined }
      )
    ).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow("Failed to fetch");
    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toMatchObject({
      name: "TransferRequestError",
      message: "refused",
      status,
    });
    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow("refused");

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2] === keys[0]).toBe(kept);
  });

  // Keegan (#2333): a 422 IDEMPOTENCY_KEY_REUSED retired the key, so the next
  // press minted a new one and could pay again while the first may have landed.
  it("keeps the key on IDEMPOTENCY_KEY_REUSED and says to restore the original or check", async () => {
    const fetchMock = stubDashboardFetch(() =>
      Response.json(
        { error: { code: "IDEMPOTENCY_KEY_REUSED", message: "reused" } },
        { status: 422 }
      )
    );

    for (const _press of [1, 2]) {
      await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow(
        "Shared.idempotency.keyReusedRestoreOriginal"
      );
    }

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  // Greptile (#2333): a refusal whose body failed to download read as an
  // answered 422 with no code, which retired the key the payment ran under.
  it("keeps the key when a refusal's body fails to download", async () => {
    const fetchMock = stubDashboardFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("network error"));
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } }
        )
    );

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow(
      "DashboardPayments.workspace.transferRequestFailed"
    );
    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow(
      "DashboardPayments.workspace.transferRequestFailed"
    );

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  // A money movement never mints a fresh key while the original may have run:
  // the next press is answered under the same key.
  it("keeps the key on an unknown outcome and resends under it", async () => {
    const fetchMock = stubDashboardFetch(confirmed).mockResolvedValueOnce(
      Response.json(
        { error: { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "use a new key" } },
        { status: 409 }
      )
    );

    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow(
      "Shared.idempotency.outcomeUnknownCheckList"
    );
    await sendTransferUnderKey(SUBMISSION, t);

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  // A key held in memory only is lost on reload, and a retry after the reload
  // would send the payment again under a fresh key.
  it("resends an earlier attempt's stored key even once storage refuses writes", async () => {
    const fetchMock = stubDashboardFetch(() =>
      Response.json({ error: { message: "unavailable" } }, { status: 503 })
    );
    await expect(sendTransferUnderKey(SUBMISSION, t)).rejects.toThrow("unavailable");

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

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("joins simultaneous sends of one payment into a single request", async () => {
    const fetchMock = stubDashboardFetch(() =>
      Response.json({ data: { transfer: { id: "xfr_2", status: "confirmed" } } })
    );

    const outcomes = await Promise.all([
      sendTransferUnderKey(SUBMISSION, t),
      sendTransferUnderKey(SUBMISSION, t),
    ]);

    // Both callers report the one payment the key joined them into.
    expect(outcomes).toEqual([
      { transfer: { id: "xfr_2", status: "confirmed" } },
      { transfer: { id: "xfr_2", status: "confirmed" } },
    ]);
    expect(sentKeys(fetchMock)).toHaveLength(1);
  });

  // A provider may repeat its signature callback after a lost event response,
  // and its session always names the same payment.
  it("keeps a provider session's key after success and across a reload, and gives another session its own", async () => {
    const fetchMock = stubDashboardFetch(() =>
      Response.json({
        data: { transfer: { id: "xfr_1", status: "confirmed", signature: "sig_1" } },
      })
    );

    await sendTransferUnderKey(SUBMISSION, t, "session_1");
    // A reload: only what session storage kept survives.
    resetTransferIdempotencyStateForTests();
    await sendTransferUnderKey(SUBMISSION, t, "session_1");
    await sendTransferUnderKey(SUBMISSION, t, "session_2");

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
