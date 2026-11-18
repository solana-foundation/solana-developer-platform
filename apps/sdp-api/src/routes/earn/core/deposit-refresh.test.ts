import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRecord } from "@/db/repositories/operations.repository";
import type { AppContext } from "@/routes/earn/context";
import { resolveDepositSwapRequest } from "@/routes/earn/handlers/shared";
import { env } from "@/test/helpers/env";
import { authorizeEarnDepositRefresh } from "./deposit-refresh";
import type { AuthorizedEarnPreparation } from "./prepare";

const { latestSwap, retainedSwap } = vi.hoisted(() => ({
  latestSwap: vi.fn(),
  retainedSwap: vi.fn(),
}));
vi.mock("@/db/client", () => ({ getDb: () => ({ queryOne: latestSwap }) }));
vi.mock("@/services/earn/strategy-swap-operations.service", () => ({
  requirePreparedSwapStrategyTransaction: retainedSwap,
  swapStrategyContinuation: (row: { strategyId: string; source: { ownerAddress: string } }) => ({
    strategyId: row.strategyId,
    source: row.source,
    depositTokenMint: "deposit-mint",
    minOutAmount: "9.5",
  }),
}));

const context = { env } as unknown as AppContext;
const record = {
  scope: { organizationId: "organization", projectId: "project", environment: "sandbox" },
  source: { ownerAddress: "owner" },
  operation: {
    id: "operation",
    intent: {
      kind: "earn.deposit",
      strategyId: "strategy",
      source: { ownerAddress: "owner" },
      amount: { mint: "funding-mint", value: "100" },
    },
  },
} as unknown as OperationRecord;
const preparation = { intent: record.operation.intent } as AuthorizedEarnPreparation;

beforeEach(() => {
  vi.clearAllMocks();
  latestSwap.mockResolvedValue({ advisory_id: "swap" });
  retainedSwap.mockResolvedValue({
    strategyId: "strategy",
    source: { ownerAddress: "owner" },
    swap_chain_status: "finalized",
  });
});

describe("post-swap deposit refresh", () => {
  it("refreshes the deposit quantity without planning another funding swap", async () => {
    const refreshed = await authorizeEarnDepositRefresh(context, record, preparation);
    expect(refreshed.intent).toMatchObject({ amount: { mint: "deposit-mint", value: "9.5" } });
    expect(record.operation.intent).toMatchObject({
      amount: { mint: "funding-mint", value: "100" },
    });
    if (refreshed.intent.kind !== "earn.deposit") throw new Error("Expected deposit");
    expect(
      resolveDepositSwapRequest({ sourceTokenMint: refreshed.intent.amount.mint }, "deposit-mint")
    ).toBeNull();
    expect(latestSwap).toHaveBeenCalledWith(
      expect.stringContaining("CASE WHEN swap.swap_chain_status = 'finalized' THEN 0 ELSE 1 END"),
      ["operation", "organization", "project", "sandbox"]
    );
    expect(retainedSwap).toHaveBeenCalledWith(
      env,
      { ...record.scope, custodyWalletId: null },
      "swap"
    );
  });

  it("keeps the original funding review before any swap was executed", async () => {
    latestSwap.mockResolvedValue(null);
    expect(await authorizeEarnDepositRefresh(context, record, preparation)).toBe(preparation);
    expect(retainedSwap).not.toHaveBeenCalled();
  });

  it("rejects a retained swap belonging to another external owner", async () => {
    retainedSwap.mockResolvedValue({
      strategyId: "strategy",
      source: { ownerAddress: "sibling" },
      swap_chain_status: "finalized",
    });
    await expect(authorizeEarnDepositRefresh(context, record, preparation)).rejects.toThrow(
      "does not belong"
    );
  });

  it("rejects an uncertain prerequisite instead of preparing a second swap", async () => {
    retainedSwap.mockResolvedValue({
      strategyId: "strategy",
      source: { ownerAddress: "owner" },
      swap_chain_status: "submitted",
    });
    await expect(authorizeEarnDepositRefresh(context, record, preparation)).rejects.toThrow(
      "must finalize"
    );
  });

  it("permits a new funding review only after the retained swap definitively failed", async () => {
    retainedSwap.mockResolvedValue({
      strategyId: "strategy",
      source: { ownerAddress: "owner" },
      swap_chain_status: "failed",
    });
    expect(await authorizeEarnDepositRefresh(context, record, preparation)).toBe(preparation);
  });

  it("does not fall back to the funding intent when the scoped advisory is missing", async () => {
    retainedSwap.mockRejectedValue(new Error("Prepared strategy swap not found"));
    await expect(authorizeEarnDepositRefresh(context, record, preparation)).rejects.toThrow(
      "not found"
    );
  });
});
