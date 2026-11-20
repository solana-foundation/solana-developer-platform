// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  prepareDepositOperation,
  refreshPreparedOperation,
  requestOperationCancellation,
  resumePendingOperation,
  submitPreparedOperation,
} from "./core-api";
import type { EarnOperation } from "./core-operation";

const operation: EarnOperation = {
  id: "operation",
  kind: "earn.deposit",
  status: "prepared",
  intent: {
    kind: "earn.deposit",
    strategyId: "strategy",
    source: { ownerAddress: "owner" },
    amount: { mint: "usdc", value: "10" },
  },
  actionId: "replacement",
  version: 2,
  nextAction: {
    type: "sign_transaction",
    transaction: "unsigned",
    lastValidBlockHeight: "100",
    expiresAt: null,
  },
  terms: {
    expiresAt: null,
    estimate: null,
    minimum: null,
    fees: null,
    options: [],
  },
  resourceRef: null,
  result: null,
  canCancel: false,
  cancelRequestedAt: null,
  error: null,
  createdAt: "2026-11-18T12:00:00Z",
  updatedAt: "2026-11-18T12:00:00Z",
};
beforeEach(() => {
  localStorage.clear();
  let chain = Promise.resolve<unknown>(undefined);
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_key: string, work: () => Promise<unknown>) => {
        const result = chain.then(work, work);
        chain = result.catch(() => undefined);
        return result;
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("refreshes terms without requesting a signature or submission", async () => {
  const fetchMock = vi.fn(
    async (_url: URL | RequestInfo, _init?: RequestInit) =>
      Response.json({ data: { operation } })
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    refreshPreparedOperation({ ...operation, nextAction: { type: "refresh" } })
  ).resolves.toMatchObject({
    actionId: "replacement",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBeDefined();
  const calls = fetchMock.mock.calls;
  expect(new URL(String(calls[0]?.[0])).pathname).toBe(
    "/api/operations/operation/refresh"
  );
  expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
    actionId: "replacement",
    version: 2,
    idempotencyKey: expect.any(String),
  });
});

it("retries cancellation of an unsubmitted choice with its saved key", async () => {
  const choice: EarnOperation = {
    ...operation,
    kind: "earn.withdraw",
    intent: {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    },
    nextAction: { type: "select_option" },
    canCancel: true,
  };
  const keys: string[] = [];
  const fetchMock = vi.fn(
    async (_url: URL | RequestInfo, init?: RequestInit) => {
      keys.push(JSON.parse(String(init?.body)).idempotencyKey);
      if (keys.length === 1) throw new Error("Response lost");
      return Response.json({
        data: {
          operation: {
            ...choice,
            status: "cancelled",
            nextAction: null,
            canCancel: false,
          },
        },
      });
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(requestOperationCancellation(choice)).rejects.toThrow(
    "Response lost"
  );
  await requestOperationCancellation(choice);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

it("never requests cancellation when the API marks the operation non-cancellable", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(requestOperationCancellation(operation)).rejects.toThrow(
    "cannot be cancelled"
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("selects a route through version-bound preparation without submission", async () => {
  const fetchMock = vi.fn(
    async (_url: URL | RequestInfo, _init?: RequestInit) =>
      Response.json({ data: { operation } })
  );
  vi.stubGlobal("fetch", fetchMock);
  await refreshPreparedOperation(
    { ...operation, nextAction: { type: "select_option" } },
    "delayed"
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
    "/api/operations/operation/refresh"
  );
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    actionId: "replacement",
    version: 2,
    optionId: "delayed",
    idempotencyKey: expect.any(String),
  });
  expect(localStorage.getItem("northstar:pending-operation:v1")).toBeNull();
});

it.each([
  "queued",
  "awaiting_signature",
  "submitted",
  "settling",
  "failed",
] as const)(
  "never requests refresh after a submission reaches %s",
  async (status) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      refreshPreparedOperation({
        ...operation,
        status,
        nextAction: { type: "refresh" },
      })
    ).rejects.toThrow("cannot be refreshed");
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

it("recovers a lost submission response after reload with the exact action and key", async () => {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(localStorage.getItem("northstar:pending-operation:v1")).toContain(
        '"operationId":"operation"'
      );
      sent.push(JSON.parse(String(init?.body)));
      if (sent.length === 1) throw new Error("Lost response after acceptance");
      return Response.json({
        data: { operation: { ...operation, status: "submitted", version: 3 } },
      });
    })
  );
  await expect(submitPreparedOperation(operation)).rejects.toThrow(
    "Lost response"
  );
  vi.resetModules();
  const reloaded = await import("./core-api");
  await expect(reloaded.resumePendingOperation()).resolves.toMatchObject({
    status: "submitted",
  });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual(sent[1]);
  expect(sent[0]).toEqual({
    actionId: "replacement",
    version: 2,
    idempotencyKey: expect.any(String),
  });
  expect(localStorage.getItem("northstar:pending-operation:v1")).toBeNull();
});

it("retains a saved action across malformed success, foreign operation and authorization failures", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: { operation: {} } }))
    .mockResolvedValueOnce(
      Response.json({ data: { operation: { ...operation, id: "other" } } })
    )
    .mockResolvedValueOnce(
      Response.json({ error: { message: "Session expired" } }, { status: 401 })
    );
  vi.stubGlobal("fetch", fetchMock);
  await expect(submitPreparedOperation(operation)).rejects.toThrow();
  const saved = localStorage.getItem("northstar:pending-operation:v1");
  await expect(resumePendingOperation()).rejects.toThrow("does not match");
  await expect(resumePendingOperation()).rejects.toThrow("Session expired");
  expect(localStorage.getItem("northstar:pending-operation:v1")).toBe(saved);
});

it("blocks new preparation and another operation while submission is uncertain", async () => {
  const fetchMock = vi.fn(async () => {
    throw new Error("Uncertain");
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(submitPreparedOperation(operation)).rejects.toThrow("Uncertain");
  await expect(prepareDepositOperation("10")).rejects.toThrow(
    "earlier pending transfer"
  );
  await expect(
    submitPreparedOperation({ ...operation, id: "other" })
  ).rejects.toThrow("earlier pending operation");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retains a malformed saved action without signing or replacing it", async () => {
  localStorage.setItem("northstar:pending-operation:v1", "invalid");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(resumePendingOperation()).rejects.toThrow();
  await expect(submitPreparedOperation(operation)).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(localStorage.getItem("northstar:pending-operation:v1")).toBe(
    "invalid"
  );
});

it("retries lost preparation with its original key without submitting", async () => {
  const keys: Array<string | null> = [];
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      paths.push(url.pathname);
      keys.push(new Headers(init?.headers).get("Idempotency-Key"));
      if (keys.length === 1) throw new Error("Lost prepare response");
      return Response.json({ data: { operation } });
    })
  );
  await expect(prepareDepositOperation("10")).rejects.toThrow("Lost prepare");
  await expect(prepareDepositOperation("10")).resolves.toMatchObject({
    id: "operation",
  });
  expect(keys[0]).toBe(keys[1]);
  expect(paths).toEqual(["/api/deposits", "/api/deposits"]);
});
