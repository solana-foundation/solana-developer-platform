// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EarnOperation } from "@/lib/core-operation";
import { OperationActivity } from "./operation-activity";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/lib/core-api", () => ({
  refreshPreparedOperation: mocks.refresh,
  executePreparedOperation: mocks.execute,
  requestOperationCancellation: mocks.cancel,
}));
const operation: EarnOperation = {
  id: "operation",
  kind: "earn.deposit",
  status: "awaiting_approval",
  intent: {
    kind: "earn.deposit",
    strategyId: "strategy",
    source: { ownerAddress: "owner" },
    amount: { mint: "usdc", value: "10" },
  },
  actionId: "action",
  version: 1,
  nextAction: { type: "refresh" },
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
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
it("offers explicitly safe refresh and requires a separate execution approval", async () => {
  mocks.refresh.mockResolvedValue({
    ...operation,
    status: "prepared",
    nextAction: { type: "execute" },
  });
  const updated = vi.fn();
  render(
    <OperationActivity
      operations={[operation]}
      strategyName="Strategy"
      symbol="USDC"
      tokenMint="usdc"
      onUpdated={updated}
    />
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Refresh terms" }))
  );
  expect(mocks.refresh).toHaveBeenCalledWith("operation");
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(updated).toHaveBeenCalledTimes(1);
});
it("keeps uncertain approvals observation-only", () => {
  render(
    <OperationActivity
      operations={[
        {
          ...operation,
          nextAction: { type: "wait", reason: "Provider outcome unknown" },
        },
      ]}
      strategyName="Strategy"
      symbol="USDC"
      tokenMint="usdc"
      onUpdated={vi.fn()}
    />
  );
  expect(screen.queryByRole("button", { name: "Refresh terms" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Approve execution" })
  ).toBeNull();
});
