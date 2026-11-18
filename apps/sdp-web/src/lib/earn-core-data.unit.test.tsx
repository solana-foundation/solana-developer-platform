// @vitest-environment jsdom
import type { Operation } from "@sdp/types/operations";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, expect, it, vi } from "vitest";
import { useEarnOperation } from "./earn-core-data";

const transport = vi.hoisted(() => vi.fn());
vi.mock("./dashboard-fetch", () => ({ dashboardRequest: transport }));

const prepared: Operation = {
  id: "operation",
  kind: "earn.deposit",
  status: "prepared",
  environment: "sandbox",
  intent: {
    kind: "earn.deposit",
    strategyId: "strategy",
    source: { walletId: "wallet" },
    amount: { mint: "usdc", value: "10" },
  },
  actionId: "action",
  version: 1,
  nextAction: { type: "submit" },
  terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
  buildRef: null,
  resourceRef: null,
  result: null,
  cancelRequestedAt: null,
  error: null,
  createdAt: "2026-11-18T12:00:00.000Z",
  updatedAt: "2026-11-18T12:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("reports changed remote observations once without echoing initial render data", async () => {
  let remote: Operation = {
    ...prepared,
    status: "queued",
    nextAction: { type: "wait", reason: "Queued" },
    updatedAt: "2026-11-18T12:01:00.000Z",
  };
  transport.mockImplementation(async () => Response.json({ data: { operation: remote } }));
  const onUpdated = vi.fn();
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
  );
  const { result } = renderHook(() => useEarnOperation(prepared.id, prepared, onUpdated), {
    wrapper,
  });
  expect(onUpdated).not.toHaveBeenCalled();
  await waitFor(() => expect(result.current.operation?.status).toBe("queued"));
  expect(onUpdated).toHaveBeenCalledExactlyOnceWith(remote);

  remote = {
    ...remote,
    status: "awaiting_approval",
    updatedAt: "2026-11-18T12:02:00.000Z",
  };
  await act(() => result.current.refresh());
  expect(onUpdated).toHaveBeenCalledTimes(2);
  expect(onUpdated).toHaveBeenLastCalledWith(remote);
  await act(() => result.current.refresh());
  expect(onUpdated).toHaveBeenCalledTimes(2);
});
