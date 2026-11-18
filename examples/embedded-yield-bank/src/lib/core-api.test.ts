// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  refreshPreparedOperation,
  requestOperationCancellation,
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
  cancelRequestedAt: null,
  error: null,
  createdAt: "2026-11-18T12:00:00Z",
  updatedAt: "2026-11-18T12:00:00Z",
};
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

it("refreshes terms without requesting a signature or execution", async () => {
  const fetchMock = vi.fn(
    async (_url: URL | RequestInfo, _init?: RequestInit) =>
      Response.json({ data: { operation } })
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(refreshPreparedOperation(operation.id)).resolves.toMatchObject({
    actionId: "replacement",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBeDefined();
  const calls = fetchMock.mock.calls;
  expect(new URL(String(calls[0]?.[0])).pathname).toBe(
    "/api/operations/operation/refresh"
  );
  expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
    idempotencyKey: expect.any(String),
  });
});

it("retries cancellation with its saved key and retires only an acknowledged request", async () => {
  const keys: string[] = [];
  const fetchMock = vi.fn(
    async (_url: URL | RequestInfo, init?: RequestInit) => {
      keys.push(JSON.parse(String(init?.body)).idempotencyKey);
      if (keys.length === 1) throw new Error("Response lost");
      return Response.json({ data: { operation } });
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(requestOperationCancellation(operation.id)).rejects.toThrow(
    "Response lost"
  );
  await requestOperationCancellation(operation.id);
  await requestOperationCancellation(operation.id);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[1]);
});
