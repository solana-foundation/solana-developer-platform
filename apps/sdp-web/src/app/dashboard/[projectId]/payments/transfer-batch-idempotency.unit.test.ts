// @vitest-environment jsdom
import type { PaymentTransferBatchRequest } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOVEMENT_POLL_INTERVAL_MS, resetMovementWatchesForTests } from "@/lib/dashboard-fetch";
import type { Translate } from "./payments-workspace.data";
import {
  canonicalTransferBatchRequest,
  claimTransferBatchIdempotencyKey,
  releaseTransferBatchIdempotencyKey,
  resetTransferBatchIdempotencyStateForTests,
  sendTransferBatchUnderKey,
  transferBatchRequestFingerprint,
} from "./transfer-batch-idempotency";

const t: Translate = (key) => key;

function batchRequest(
  overrides: Partial<PaymentTransferBatchRequest> = {}
): PaymentTransferBatchRequest {
  return {
    sourceCustodyWalletId: "cwlt_1",
    token: "USDC",
    recipients: [
      { counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "1.5" },
      { counterpartyId: "cp_2", counterpartyAccountId: "acct_2", amount: "2" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetTransferBatchIdempotencyStateForTests();
  resetMovementWatchesForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("canonicalTransferBatchRequest", () => {
  it("sends one intent as one body regardless of selection order", () => {
    // The API fingerprints recipients IN ORDER. Two clients of the same intent
    // must therefore agree on the order, or the retry is refused as a key
    // conflict and the wizard opens a second batch.
    const forward = batchRequest();
    const reversed = batchRequest({ recipients: [...forward.recipients].reverse() });
    expect(canonicalTransferBatchRequest(reversed)).toEqual(canonicalTransferBatchRequest(forward));
    expect(
      canonicalTransferBatchRequest(reversed).recipients.map((r) => r.counterpartyAccountId)
    ).toEqual(["acct_1", "acct_2"]);
  });

  it("leaves everything except recipient order alone", () => {
    const request = batchRequest({ externalId: "ext_1" });
    const canonical = canonicalTransferBatchRequest(request);
    expect(canonical.sourceCustodyWalletId).toBe(request.sourceCustodyWalletId);
    expect(canonical.token).toBe(request.token);
    expect(canonical.externalId).toBe("ext_1");
    expect(canonical.recipients).toHaveLength(request.recipients.length);
  });
});

describe("transferBatchRequestFingerprint", () => {
  it("is stable across recipient selection order", () => {
    const forward = batchRequest();
    const reversed = batchRequest({ recipients: [...forward.recipients].reverse() });
    expect(transferBatchRequestFingerprint(forward)).toBe(
      transferBatchRequestFingerprint(reversed)
    );
  });

  it("differs when any part of the intent changes", () => {
    const base = transferBatchRequestFingerprint(batchRequest());
    expect(
      transferBatchRequestFingerprint(batchRequest({ sourceCustodyWalletId: "cwlt_2" }))
    ).not.toBe(base);
    expect(transferBatchRequestFingerprint(batchRequest({ token: "SOL" }))).not.toBe(base);
    expect(transferBatchRequestFingerprint(batchRequest({ externalId: "ref-1" }))).not.toBe(base);
    expect(
      transferBatchRequestFingerprint(
        batchRequest({
          recipients: [{ counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "9" }],
        })
      )
    ).not.toBe(base);
  });
});

describe("claim / release", () => {
  it("returns the same key for the same fingerprint until released", () => {
    const fingerprint = transferBatchRequestFingerprint(batchRequest());
    const first = claimTransferBatchIdempotencyKey(fingerprint);
    expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(first);

    releaseTransferBatchIdempotencyKey(fingerprint, first);
    expect(claimTransferBatchIdempotencyKey(fingerprint)).not.toBe(first);
  });

  it("mints distinct keys for distinct fingerprints", () => {
    const a = claimTransferBatchIdempotencyKey("fingerprint-a");
    const b = claimTransferBatchIdempotencyKey("fingerprint-b");
    expect(a).not.toBe(b);
  });

  it("survives what a reload leaves behind: the sessionStorage snapshot", () => {
    const fingerprint = transferBatchRequestFingerprint(batchRequest());
    const key = claimTransferBatchIdempotencyKey(fingerprint);
    // A reload loses module state but keeps sessionStorage.
    resetTransferBatchIdempotencyStateForTests();
    expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(key);
  });
});

describe("sendTransferBatchUnderKey", () => {
  const recorded = () =>
    Response.json({ data: { batch: { id: "batch_1" }, recipients: [], transfers: [] } });

  function sentKeys(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): (string | null)[] {
    return fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key")
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retires the key once the API records the batch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => recorded());
    vi.stubGlobal("fetch", fetchMock);

    await sendTransferBatchUnderKey(batchRequest(), t);
    await sendTransferBatchUnderKey(batchRequest(), t);

    const [first, second] = sentKeys(fetchMock);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  // APE-461: the same rule as a single transfer, on a batch still processing:
  // the stale replay keeps the key, and a GET showing the batch final retires it.
  it("keeps the key through a stale replay and retires it once a GET shows the batch final", async () => {
    vi.useFakeTimers();
    let posts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "GET") {
        return Response.json({ data: { batch: { id: "batch_1", status: "confirmed" } } });
      }
      posts += 1;
      return Response.json(
        {
          data: {
            batch: { id: "batch_1", status: "processing" },
            recipients: [],
            transfers: [],
          },
        },
        posts > 1 ? { headers: { "Idempotent-Replayed": "true" } } : undefined
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendTransferBatchUnderKey(batchRequest(), t);
    await sendTransferBatchUnderKey(batchRequest(), t);
    await vi.advanceTimersByTimeAsync(MOVEMENT_POLL_INTERVAL_MS);
    await sendTransferBatchUnderKey(batchRequest(), t);

    const posted = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    const [first, replay, next] = posted.map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key")
    );
    expect(replay).toBe(first);
    expect(next).not.toBe(first);
    const read = fetchMock.mock.calls.find(([, init]) => init?.method === "GET");
    expect(read?.[0]).toBe("/api/dashboard/payments/transfers/batch/batch_1");
  });

  it("retires a fresh key on a first-attempt refusal", async () => {
    const fetchMock = vi
      .fn<typeof fetch>(async () => recorded())
      .mockResolvedValueOnce(Response.json({ error: { message: "bad" } }, { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTransferBatchUnderKey(batchRequest(), t)).rejects.toMatchObject({
      status: 422,
    });
    await sendTransferBatchUnderKey(batchRequest(), t);

    const [refused, next] = sentKeys(fetchMock);
    expect(next).not.toBe(refused);
  });

  // A money movement never mints a fresh key while the original may have run:
  // the next press is answered under the same key.
  it("keeps the key on an unknown outcome and resends under it", async () => {
    const fetchMock = vi
      .fn<typeof fetch>(async () => recorded())
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "use a new key" } },
          { status: 409 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTransferBatchUnderKey(batchRequest(), t)).rejects.toThrow(
      "Shared.idempotency.outcomeUnknownCheckList"
    );
    await sendTransferBatchUnderKey(batchRequest(), t);

    const [unknown, next] = sentKeys(fetchMock);
    expect(next).toBe(unknown);
  });

  // Browser test (HOO-1918): the API recorded the batch but the answer was lost;
  // a refusal after that settles nothing about the recorded batch, so the third
  // press must replay it under the first key, not pay every recipient again.
  it.each([
    ["a rate limit", 429],
    ["an expired session", 401],
  ])("keeps a lost attempt's key through %s", async (_label, status) => {
    const fetchMock = vi
      .fn<typeof fetch>(async () => recorded())
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(Response.json({ error: { message: "refused" } }, { status }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTransferBatchUnderKey(batchRequest(), t)).rejects.toThrow("Failed to fetch");
    await expect(sendTransferBatchUnderKey(batchRequest(), t)).rejects.toMatchObject({ status });
    await sendTransferBatchUnderKey(batchRequest(), t);

    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("degraded storage", () => {
  // A batch whose key lives in memory only could be sent twice by a reload and
  // retry, so it is refused like every other money movement.
  it("refuses to send a batch whose key storage refused", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      await expect(sendTransferBatchUnderKey(batchRequest(), t)).rejects.toMatchObject({
        name: "TransferBatchRequestError",
        status: 428,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the key stable in memory when sessionStorage refuses writes", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      const fingerprint = "fingerprint-quota";
      const key = claimTransferBatchIdempotencyKey(fingerprint);
      expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(key);
    } finally {
      setItem.mockRestore();
    }
  });

  it("prefers memory over stale readable storage after a failed write", () => {
    const fingerprint = "fingerprint-diverged";
    const stale = claimTransferBatchIdempotencyKey(fingerprint);
    releaseTransferBatchIdempotencyKey(fingerprint, stale);

    // The release reached storage; now the NEXT claim's write fails, leaving
    // storage stale while memory holds the fresh key.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      const fresh = claimTransferBatchIdempotencyKey(fingerprint);
      expect(fresh).not.toBe(stale);
      expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(fresh);
    } finally {
      setItem.mockRestore();
    }
  });
});
