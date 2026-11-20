import type { Operation } from "@sdp/types/operations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { env } from "@/test/helpers/env";
import { projectWithdrawalRecovery } from "./strategy-withdrawal-recovery-projection.service";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => ({ queryOne: mocks.read }) }));
const scope: OperationScope = {
  organizationId: "org",
  projectId: "project",
  environment: "sandbox",
};
const operation: Operation = {
  id: "operation",
  kind: "earn.withdraw",
  status: "settling",
  environment: "sandbox",
  intent: { kind: "earn.withdraw", positionId: "position", amount: { kind: "all" } },
  actionId: "action",
  version: 1,
  nextAction: { type: "wait", reason: "Recovery pending" },
  terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
  buildRef: { kind: "earn.withdrawal_recovery", id: "build" },
  resourceRef: { kind: "earn.withdrawal_recovery", id: "exact-action" },
  canCancel: false,
  cancelRequestedAt: null,
  error: null,
  result: null,
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};
function row(overrides: Record<string, unknown> = {}) {
  return {
    action_status: "finalized",
    signature: "exact-signature",
    failure_reason: null,
    request_status: "cancelled",
    cancel_signature: "exact-signature",
    closing_signature: "exact-signature",
    position_id: "position",
    strategy_id: "strategy",
    source: { ownerAddress: "owner" },
    custody_wallet_id: null,
    owner_address: "owner",
    share_mint: "share",
    shares: "5",
    ...overrides,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(row());
});

describe("exact withdrawal recovery projection", () => {
  it("completes only the exact finalized action and reports returned shares", async () => {
    expect(await projectWithdrawalRecovery(env, scope, operation, "exact-action")).toMatchObject({
      status: "completed",
      nextAction: null,
      error: null,
      result: {
        signature: "exact-signature",
        settledAmount: { mint: "share", value: "5" },
        settlementOutcome: "recovered",
      },
    });
    expect(mocks.read).toHaveBeenCalledWith(expect.any(String), [
      "exact-action",
      "operation",
      "org",
      "project",
      "sandbox",
    ]);
  });

  it("does not complete from a different action's cancellation", async () => {
    mocks.read.mockResolvedValue(
      row({ cancel_signature: "different", closing_signature: "different" })
    );
    expect(await projectWithdrawalRecovery(env, scope, operation, "exact-action")).toMatchObject({
      status: "failed",
      result: { settledAmount: null, settlementOutcome: null },
    });
  });

  it("keeps confirmed-only recovery waiting despite a cancelled request", async () => {
    mocks.read.mockResolvedValue(row({ action_status: "confirmed" }));
    expect(await projectWithdrawalRecovery(env, scope, operation, "exact-action")).toMatchObject({
      status: "settling",
      nextAction: { type: "wait" },
      result: { settledAmount: null, settlementOutcome: null },
    });
  });

  it("keeps an unknown close waiting without claiming returned shares", async () => {
    mocks.read.mockResolvedValue(
      row({ request_status: "closed_or_unknown", cancel_signature: null, closing_signature: null })
    );
    expect(await projectWithdrawalRecovery(env, scope, operation, "exact-action")).toMatchObject({
      status: "settling",
      result: { settledAmount: null, settlementOutcome: null },
    });
  });

  it("rejects a row whose signing source does not match the operation", async () => {
    mocks.read.mockResolvedValue(row({ source: { ownerAddress: "another-owner" } }));
    await expect(projectWithdrawalRecovery(env, scope, operation, "exact-action")).rejects.toThrow(
      "not found"
    );
  });
});
