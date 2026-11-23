// @vitest-environment jsdom
/**
 * A transfer batch's idempotency key and payout run name, as the requests the dashboard sends
 * carry them: every resend of one batch goes out under the same key and names the same run until
 * an answer settles it, and a different batch is a different request.
 */

import type { PaymentTransferBatchStatus } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";
import { MOVEMENT_POLL_INTERVAL_MS, resetMovementWatchesForTests } from "@/lib/dashboard-fetch";
import { KEPT_KEY_WINDOW_MS } from "@/lib/idempotency-key-store";
import { sentDashboardRequests, stubDashboardFetch } from "@/test/dashboard-fetch";
import { required } from "@/test/required";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { TransferBatchRequestError, type Translate } from "./payments-workspace.data";
import {
  type DashboardTransferBatchRequest,
  isTransferBatchSendOutcomeUnknown,
  resetTransferBatchIdempotencyStateForTests,
  retryTransferBatchUnderKey,
  sendTransferBatchUnderKey,
} from "./transfer-batch-idempotency";

const SEND_PATH = "/api/dashboard/payments/transfers/batch";
const RETRY_PATH = "/api/dashboard/payments/transfers/batch/batch_1/retry";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECIPIENT_1 = { counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "1.5" };
const RECIPIENT_2 = { counterpartyId: "cp_2", counterpartyAccountId: "acct_2", amount: "2" };
const BATCH: DashboardTransferBatchRequest = {
  projectId: "prj_1",
  sourceCustodyWalletId: "cwlt_1",
  token: requiredWellKnownMint("USDC", "devnet"),
  recipients: [RECIPIENT_1, RECIPIENT_2],
};
const runNameSchema = z.object({ externalId: z.string() });

const t: Translate = (key) => key;

const answer = (status: PaymentTransferBatchStatus, init?: ResponseInit) =>
  Response.json(
    { data: { batch: { id: "batch_1", status }, recipients: [], transfers: [] } },
    init
  );
const refusal = (status: number, error: { code?: string; message: string }) =>
  Response.json({ error }, { status });

/** Pins the clock's date only, so the movement watch's timers still run. */
function today(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

function sentSends(fetchMock: Mock<typeof fetch>) {
  return sentDashboardRequests(fetchMock).filter(
    (request) => request.method === "POST" && request.path === SEND_PATH
  );
}

/** The payout run each batch send named, in order. */
function sentRunNames(fetchMock: Mock<typeof fetch>): string[] {
  return sentSends(fetchMock).map((request) => runNameSchema.parse(request.body).externalId);
}

/**
 * Asserts the Idempotency-Key the requests on `path` carried, one label per request: the same
 * label for the same key, a different label for a different one.
 */
function expectSentKeys(fetchMock: Mock<typeof fetch>, labels: string[], path = SEND_PATH) {
  const keys = sentDashboardRequests(fetchMock)
    .filter((request) => request.method === "POST" && request.path === path)
    .map((request) => request.idempotencyKey);
  expect(keys).toHaveLength(labels.length);
  for (const key of keys) expect(key).toMatch(UUID);
  expect(keys).toEqual(labels.map((label) => keys[labels.indexOf(label)]));
  expect(new Set(keys).size).toBe(new Set(labels).size);
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetTransferBatchIdempotencyStateForTests();
  resetMovementWatchesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sendTransferBatchUnderKey", () => {
  // The API fingerprints recipients in any order and amounts however spelled, so a resend that
  // reorders or re-spells the batch must reuse the key, or it would pay everyone again.
  it("resends a lost batch, reordered and re-spelled, as the same body under the same key", async () => {
    today("2026-11-10T12:00:00Z");
    const fetchMock = stubDashboardFetch(() => answer("confirmed")).mockRejectedValueOnce(
      new TypeError("Failed to fetch")
    );

    await expect(
      sendTransferBatchUnderKey(
        { ...BATCH, recipients: [RECIPIENT_2, { ...RECIPIENT_1, amount: "01.50" }] },
        t
      )
    ).rejects.toThrow("Failed to fetch");
    await sendTransferBatchUnderKey(BATCH, t);

    const sent = { ...BATCH, externalId: expect.stringMatching(/^batch-2026-11-10-[0-9a-f]{16}$/) };
    expect(sentSends(fetchMock).map((request) => request.body)).toEqual([sent, sent]);
    expectSentKeys(fetchMock, ["lost", "lost"]);
    expect(new Set(sentRunNames(fetchMock)).size).toBe(1);
  });

  it("sends a different batch under a new key, named a different run", async () => {
    const fetchMock = stubDashboardFetch(() => refusal(503, { message: "unavailable" }));

    for (const batch of [
      BATCH,
      { ...BATCH, projectId: "prj_2" },
      { ...BATCH, sourceCustodyWalletId: "cwlt_2" },
      { ...BATCH, token: SOL_MINT },
      { ...BATCH, recipients: [{ ...RECIPIENT_1, amount: "1.6" }, RECIPIENT_2] },
      { ...BATCH, recipients: [RECIPIENT_1] },
      { ...BATCH, externalId: "payroll-11" },
    ]) {
      await expect(sendTransferBatchUnderKey(batch, t)).rejects.toThrow("unavailable");
    }

    expectSentKeys(fetchMock, ["a", "b", "c", "d", "e", "f", "g"]);
    expect(new Set(sentRunNames(fetchMock)).size).toBe(7);
  });

  // A lost batch resent by the next release must find the same key and run name, or it is sent
  // as a new run under a new key and pays every recipient again.
  it("stores and sends a batch's key and run name under the exact names a later release reads", async () => {
    today("2026-11-10T12:00:00Z");
    const fetchMock = stubDashboardFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toThrow("Failed to fetch");

    const runName = "batch-2026-11-10-a8f2988e4b666114";
    const [sent] = sentSends(fetchMock);
    expect(required(sent).body).toEqual({ ...BATCH, externalId: runName });
    expect(Object.keys(window.localStorage)).toEqual([
      "sdp:payments:transfer-batch:reference:v1:a8f2988e4b666114",
    ]);
    expect(
      JSON.parse(
        required(window.sessionStorage.getItem("sdp:payments:transfer-batch:idempotency:v1"))
      )
    ).toEqual([
      {
        id: `["prj_1","${runName}","cwlt_1","${BATCH.token}",[["cp_1","acct_1","1.5"],["cp_2","acct_2","2"]]]`,
        value: required(sent).idempotencyKey,
        claimedAt: 1794312000000,
      },
    ]);
  });

  it("resends a lost batch under its key after a reload", async () => {
    const fetchMock = stubDashboardFetch(() => answer("confirmed")).mockRejectedValueOnce(
      new TypeError("Failed to fetch")
    );

    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toThrow("Failed to fetch");
    // A reload keeps session storage and loses module state.
    resetTransferBatchIdempotencyStateForTests();
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["lost", "lost"]);
  });

  // HOO-2335: another tab or operator sending the same batch the same day names the same run,
  // so the API answers it with the first batch instead of paying everyone again.
  it("names the same batch the same run from another browser on the same day", async () => {
    today("2026-11-10T09:00:00Z");
    const fetchMock = stubDashboardFetch(() => answer("confirmed"));

    await sendTransferBatchUnderKey(BATCH, t);
    window.sessionStorage.clear();
    window.localStorage.clear();
    resetTransferBatchIdempotencyStateForTests();
    vi.setSystemTime(new Date("2026-11-10T21:00:00Z"));
    await sendTransferBatchUnderKey({ ...BATCH, recipients: [RECIPIENT_2, RECIPIENT_1] }, t);

    const [first, again] = sentRunNames(fetchMock);
    expect(first).toMatch(/^batch-2026-11-10-[0-9a-f]{16}$/);
    expect(again).toBe(first);
  });

  it("names a send whose answer was lost the same run from a new tab the next day", async () => {
    today("2026-11-10T12:00:00Z");
    const fetchMock = stubDashboardFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toThrow("Failed to fetch");
    // A new tab: the key store is empty, the run's name is not.
    window.sessionStorage.clear();
    resetTransferBatchIdempotencyStateForTests();
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toThrow("Failed to fetch");

    const [first, again] = sentRunNames(fetchMock);
    expect(first).toMatch(/^batch-2026-11-10-[0-9a-f]{16}$/);
    expect(again).toBe(first);
  });

  // The API answers a batch's key from the batch row after its 24-hour key record lapses, so a
  // resend on a later day replays the same run under the same key.
  it("resends a kept key and its run name however old they are", async () => {
    today("2026-11-09T20:00:00Z");
    const fetchMock = stubDashboardFetch(() => answer("confirmed")).mockRejectedValueOnce(
      new TypeError("Failed to fetch")
    );

    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toThrow("Failed to fetch");
    vi.setSystemTime(Date.now() + KEPT_KEY_WINDOW_MS);
    await sendTransferBatchUnderKey(BATCH, t);

    const [first, resent] = sentRunNames(fetchMock);
    expect(first).toMatch(/^batch-2026-11-09-/);
    expect(resent).toBe(first);
    expectSentKeys(fetchMock, ["lost", "lost"]);
  });

  it("sends the same batch again under a new key, named for its day, once the API answers it final", async () => {
    today("2026-11-10T12:00:00Z");
    const fetchMock = stubDashboardFetch(() => answer("confirmed"));

    await sendTransferBatchUnderKey(BATCH, t);
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["first", "next"]);
    expect(sentRunNames(fetchMock)).toEqual([
      expect.stringMatching(/^batch-2026-11-10-/),
      expect.stringMatching(/^batch-2026-11-11-/),
    ]);
  });

  it("sends the reference the user typed as the run name", async () => {
    const fetchMock = stubDashboardFetch(() => answer("confirmed"));

    await sendTransferBatchUnderKey({ ...BATCH, externalId: "payroll-2026-05" }, t);

    expect(sentRunNames(fetchMock)).toEqual(["payroll-2026-05"]);
  });

  // APE-461: the replay repeats the first answer, so only a GET showing the batch final retires it.
  it("keeps the key through a stale replay and retires it once a GET shows the batch final", async () => {
    vi.useFakeTimers();
    let posts = 0;
    const fetchMock = stubDashboardFetch(({ method }) => {
      if (method === "GET") return answer("confirmed");
      posts += 1;
      return answer(
        "processing",
        posts > 1 ? { headers: { "Idempotent-Replayed": "true" } } : undefined
      );
    });

    await sendTransferBatchUnderKey(BATCH, t);
    await sendTransferBatchUnderKey(BATCH, t);
    await sendTransferBatchUnderKey(BATCH, t);
    await vi.advanceTimersByTimeAsync(MOVEMENT_POLL_INTERVAL_MS);
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["first", "first", "first", "next"]);
    expect(
      sentDashboardRequests(fetchMock)
        .filter((request) => request.method === "GET")
        .map((request) => request.path)
    ).toEqual(["/api/dashboard/payments/transfers/batch/batch_1"]);
  });

  it("retires a fresh key on a first-attempt refusal", async () => {
    const fetchMock = stubDashboardFetch(() => answer("confirmed")).mockResolvedValueOnce(
      refusal(422, { message: "bad" })
    );

    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toMatchObject({
      name: "TransferBatchRequestError",
      status: 422,
    });
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["refused", "next"]);
  });

  it("resends a batch refused while its movement was stopped under the same key", async () => {
    const fetchMock = stubDashboardFetch(() => answer("confirmed")).mockResolvedValueOnce(
      refusal(403, { code: "FORBIDDEN", message: "This movement is disabled for the project" })
    );

    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toThrow(
      "This movement is disabled for the project"
    );
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["refused", "refused"]);
  });

  it("keeps the key on an unknown outcome and resends under it", async () => {
    const fetchMock = stubDashboardFetch(() => answer("confirmed")).mockResolvedValueOnce(
      refusal(409, { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "use a new key" })
    );

    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toThrow(
      "Shared.idempotency.outcomeUnknownCheckList"
    );
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["unknown", "unknown"]);
  });

  // HOO-1918: the API recorded the batch but the answer was lost; a refusal after that settles
  // nothing about the recorded batch, so the third press replays it under the first key.
  it.each([
    ["a rate limit", 429],
    ["an expired session", 401],
  ])("keeps a lost attempt's key through %s", async (_label, status) => {
    const fetchMock = stubDashboardFetch(() => answer("confirmed"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(refusal(status, { message: "refused" }));

    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toThrow("Failed to fetch");
    await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toMatchObject({ status });
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["lost", "lost", "lost"]);
  });

  // A key held in memory only could be lost to a reload, and the resend would pay again.
  it("sends nothing when the browser refuses to store the batch's key", async () => {
    const fetchMock = stubDashboardFetch(() => answer("confirmed"));
    // SAFETY: This is the runtime prototype of the Storage instance under test.
    // Spying on Storage.prototype misses this jsdom implementation's setItem.
    const sessionStoragePrototype = Object.getPrototypeOf(window.sessionStorage) as Storage;
    const setItem = vi.spyOn(sessionStoragePrototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      await expect(sendTransferBatchUnderKey(BATCH, t)).rejects.toMatchObject({
        name: "TransferBatchRequestError",
        status: 428,
      });
    } finally {
      setItem.mockRestore();
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a partially failed batch (APE-462)", () => {
  // Sending it again must replay it, not pay the recipients who were paid.
  it("keeps the key of a batch answered partially failed", async () => {
    const fetchMock = stubDashboardFetch(() => answer("partially_failed"));

    await sendTransferBatchUnderKey(BATCH, t);
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["first", "first"]);
  });

  it("keeps the key when a GET shows the processing batch ended partially failed", async () => {
    vi.useFakeTimers();
    const fetchMock = stubDashboardFetch(({ method }) =>
      method === "GET" ? answer("partially_failed") : answer("processing")
    );

    await sendTransferBatchUnderKey(BATCH, t);
    await vi.advanceTimersByTimeAsync(MOVEMENT_POLL_INTERVAL_MS);
    await sendTransferBatchUnderKey(BATCH, t);

    expectSentKeys(fetchMock, ["first", "first"]);
  });

  it("names a resend the same run until a retry finishes the batch", async () => {
    today("2026-11-10T12:00:00Z");
    let firstRunName: string | undefined;
    const fetchMock = stubDashboardFetch(({ path, body }) => {
      if (path === RETRY_PATH) {
        return Response.json({
          data: {
            batch: { id: "batch_1", status: "confirmed", externalId: firstRunName },
            recipients: [],
            transfers: [],
          },
        });
      }
      firstRunName ??= runNameSchema.parse(body).externalId;
      return answer("partially_failed");
    });

    await sendTransferBatchUnderKey(BATCH, t);
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    await sendTransferBatchUnderKey(BATCH, t);
    await retryTransferBatchUnderKey("batch_1", ["xrec_2"], t);
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    await sendTransferBatchUnderKey(BATCH, t);

    expect(sentRunNames(fetchMock)).toEqual([
      expect.stringMatching(/^batch-2026-11-10-/),
      firstRunName,
      expect.stringMatching(/^batch-2026-11-12-/),
    ]);
    expectSentKeys(fetchMock, ["first", "first", "next"]);
  });
});

describe("retryTransferBatchUnderKey", () => {
  const retried = () => answer("processing");

  it("posts the batch's retry, and a recorded answer retires the key at once", async () => {
    const fetchMock = stubDashboardFetch(retried);

    await retryTransferBatchUnderKey("batch_1", ["xrec_2"], t);
    await retryTransferBatchUnderKey("batch_1", ["xrec_2"], t);

    // Safe: the API only sends recipients still failed when it runs.
    expectSentKeys(fetchMock, ["first", "next"], RETRY_PATH);
  });

  it("keeps the key on an unknown outcome, so the next press is answered under it", async () => {
    const fetchMock = stubDashboardFetch(retried).mockResolvedValueOnce(
      refusal(409, { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "use a new key" })
    );

    await expect(retryTransferBatchUnderKey("batch_1", ["xrec_2"], t)).rejects.toThrow(
      "Shared.idempotency.outcomeUnknownCheckList"
    );
    await retryTransferBatchUnderKey("batch_1", ["xrec_2"], t);

    expectSentKeys(fetchMock, ["unknown", "unknown"], RETRY_PATH);
  });
});

describe("isTransferBatchSendOutcomeUnknown", () => {
  const refused = (status: number, code: string | null = null) =>
    new TransferBatchRequestError("refused", status, false, code);

  it("holds a send that may have recorded the batch", () => {
    expect(isTransferBatchSendOutcomeUnknown(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransferBatchSendOutcomeUnknown(refused(502))).toBe(true);
    expect(isTransferBatchSendOutcomeUnknown(refused(409, "IDEMPOTENCY_KEY_IN_FLIGHT"))).toBe(true);
    expect(isTransferBatchSendOutcomeUnknown(refused(409, "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN"))).toBe(
      true
    );
    expect(isTransferBatchSendOutcomeUnknown(refused(422, "IDEMPOTENCY_KEY_REUSED"))).toBe(true);
  });

  it("frees a send refused before anything was written", () => {
    expect(isTransferBatchSendOutcomeUnknown(refused(400, "VALIDATION_ERROR"))).toBe(false);
    expect(isTransferBatchSendOutcomeUnknown(refused(403, "FORBIDDEN"))).toBe(false);
    expect(isTransferBatchSendOutcomeUnknown(refused(409, "TRANSFER_BATCH_RUN_EXISTS"))).toBe(
      false
    );
    expect(isTransferBatchSendOutcomeUnknown(refused(428))).toBe(false);
    expect(isTransferBatchSendOutcomeUnknown(refused(429))).toBe(false);
  });
});
