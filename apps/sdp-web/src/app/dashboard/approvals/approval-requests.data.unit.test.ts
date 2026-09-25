import type { ApprovalRequestStatus, WalletApprovalRequestSummary } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  type ApprovalInboxFilters,
  approvalBadgeStatus,
  approvalExecutionState,
  approvalRequestsInProjectScope,
  EMPTY_APPROVAL_FILTERS,
  filterApprovalRequests,
  formatApprovalLabel,
  mergeApprovalRequests,
  scopedApprovalBatch,
} from "./approval-requests.data";

function approvalRequest(
  id: string,
  status: ApprovalRequestStatus,
  overrides: Partial<WalletApprovalRequestSummary> = {}
): WalletApprovalRequestSummary {
  return {
    id,
    organizationId: "org-1",
    projectId: "project-1",
    walletOperationId: `operation-${id}`,
    approvalGroupId: null,
    status,
    provider: "privy",
    providerReference: null,
    requestedBy: "user-1",
    resolvedBy: status === "pending" ? null : "user-2",
    expiresAt: null,
    resolvedAt: status === "pending" ? null : "2026-07-16T13:00:00.000Z",
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    wallet: {
      custodyWalletId: "custody-wallet-1",
      walletId: "wallet-1",
      publicKey: "Wallet111111111111111111111111111111111",
      label: "Treasury",
    },
    operation: {
      id: `operation-${id}`,
      custodyWalletId: "custody-wallet-1",
      walletId: "wallet-1",
      apiKeyId: "key-1",
      source: "payments",
      operationFamily: "transfer",
      operationType: "payment_transfer_execute",
      asset: "USDC",
      amount: "25000",
      destination: "Destination11111111111111111111111111111",
      status: status === "pending" ? "pending_approval" : "completed",
      executionStartedAt: status === "pending" ? null : "2026-07-16T12:30:00.000Z",
      executionCompletedAt: status === "pending" ? null : "2026-07-16T13:00:00.000Z",
      executionError: null,
      createdAt: "2026-07-16T12:00:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z",
    },
    policyEvaluation: {
      id: `evaluation-${id}`,
      decision: "approval_required",
      reasonCode: "amount_limit",
      reason: "Daily transfer limit requires approval",
      matchedRules: [],
      requiresApproval: true,
      evaluatedAt: "2026-07-16T12:00:00.000Z",
    },
    viewerIsRequester: false,
    viewerCanDecide: true,
    ...overrides,
  };
}

const requests = [
  approvalRequest("pending", "pending"),
  approvalRequest("approved", "approved"),
  approvalRequest("rejected", "rejected", {
    createdAt: "2026-07-14T12:00:00.000Z",
    operation: {
      ...approvalRequest("base", "rejected").operation,
      walletId: "wallet-2",
      apiKeyId: "key-2",
      operationFamily: "issuance",
    },
  }),
];

function filters(overrides: Partial<ApprovalInboxFilters>): ApprovalInboxFilters {
  return { ...EMPTY_APPROVAL_FILTERS, ...overrides };
}

describe("filterApprovalRequests", () => {
  it("separates pending requests from history", () => {
    expect(
      filterApprovalRequests(requests, "pending", EMPTY_APPROVAL_FILTERS).map(({ id }) => id)
    ).toEqual(["pending"]);
    expect(
      filterApprovalRequests(requests, "history", EMPTY_APPROVAL_FILTERS).map(({ id }) => id)
    ).toEqual(["approved", "rejected"]);
  });

  it("filters history by status", () => {
    expect(
      filterApprovalRequests(requests, "history", filters({ status: "rejected" }))
    ).toHaveLength(1);
  });

  it("filters by wallet, operation family, and API key", () => {
    const result = filterApprovalRequests(
      requests,
      "history",
      filters({ walletId: "wallet-2", operationFamily: "issuance", apiKeyId: "key-2" })
    );
    expect(result.map(({ id }) => id)).toEqual(["rejected"]);
  });

  it("filters inclusively by submitted date", () => {
    expect(
      filterApprovalRequests(
        requests,
        "history",
        filters({ from: "2026-07-16", to: "2026-07-16" })
      ).map(({ id }) => id)
    ).toEqual(["approved"]);
  });

  it("uses the user's local day for submitted-date filters", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const lateLocalRequest = approvalRequest("late-local", "approved", {
        createdAt: "2026-07-16T06:30:00.000Z",
      });
      expect(
        filterApprovalRequests(
          [lateLocalRequest],
          "history",
          filters({ from: "2026-07-15", to: "2026-07-15" })
        ).map(({ id }) => id)
      ).toEqual(["late-local"]);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});

describe("mergeApprovalRequests", () => {
  it("keeps old pending requests while deduplicating recent results", () => {
    const oldPending = approvalRequest("old-pending", "pending");
    const recent = approvalRequest("recent", "approved");
    expect(mergeApprovalRequests([oldPending], [recent, oldPending]).map(({ id }) => id)).toEqual([
      "old-pending",
      "recent",
    ]);
  });
});

describe("formatApprovalLabel", () => {
  it("uses the policy UI names for operation families", () => {
    expect(formatApprovalLabel("payment")).toBe("Payment");
    expect(formatApprovalLabel("issuance")).toBe("Issuance");
  });

  it("formats API labels and camel case values", () => {
    expect(formatApprovalLabel("approval_required")).toBe("Approval Required");
    expect(formatApprovalLabel("pendingApproval")).toBe("Pending Approval");
  });
});

describe("approvalExecutionState", () => {
  function withOperationStatus(
    status: ApprovalRequestStatus,
    operationStatus: WalletApprovalRequestSummary["operation"]["status"]
  ): WalletApprovalRequestSummary {
    const request = approvalRequest("execution", status);
    return { ...request, operation: { ...request.operation, status: operationStatus } };
  }

  it.each([
    ["completed", "succeeded"],
    ["failed", "failed"],
    ["executing", "running"],
    ["created", "not_run"],
    ["evaluated", "not_run"],
    ["pending_approval", "not_run"],
    ["canceled", "not_run"],
  ] as const)("reads an approved request with a %s operation as %s", (operationStatus, state) => {
    expect(approvalExecutionState(withOperationStatus("approved", operationStatus))).toBe(state);
  });

  it.each(["pending", "rejected", "canceled", "expired", "failed"] as const)(
    "has no execution outcome for a %s request",
    (status) => {
      expect(approvalExecutionState(withOperationStatus(status, "failed"))).toBeNull();
    }
  );

  it("badges only an approved request whose execution failed as execution_failed", () => {
    expect(approvalBadgeStatus(withOperationStatus("approved", "failed"))).toBe("execution_failed");
    expect(approvalBadgeStatus(withOperationStatus("approved", "completed"))).toBe("approved");
    expect(approvalBadgeStatus(withOperationStatus("approved", "executing"))).toBe("approved");
    expect(approvalBadgeStatus(withOperationStatus("failed", "failed"))).toBe("failed");
  });
});

describe("approvalRequestsInProjectScope", () => {
  it("accepts a batch whose rows all carry the bound project", () => {
    expect(approvalRequestsInProjectScope([approvalRequest("a", "pending")], "project-1")).toBe(
      true
    );
  });

  it("rejects a batch carrying another project's row", () => {
    const batch = [
      approvalRequest("a", "pending"),
      approvalRequest("b", "pending", { projectId: "project-2" }),
    ];
    expect(approvalRequestsInProjectScope(batch, "project-1")).toBe(false);
  });

  it("rejects a batch with a row that reports no project", () => {
    const batch = [approvalRequest("a", "pending", { projectId: null })];
    expect(approvalRequestsInProjectScope(batch, "project-1")).toBe(false);
  });

  // An empty batch carries no rows, so it proves nothing about which project
  // answered: an older proxy still resolving the shared selection cookie can
  // return one for a sibling tab's empty project.
  it("never reads an empty batch as in scope", () => {
    expect(approvalRequestsInProjectScope([], "project-1")).toBe(false);
  });
});

describe("scopedApprovalBatch", () => {
  const inScope = [approvalRequest("a", "pending")];

  it("merges a pair whose rows all carry the bound project", () => {
    expect(scopedApprovalBatch(inScope, inScope, "project-1")).toEqual(inScope);
  });

  it("skips the repaint when both batches are empty", () => {
    expect(scopedApprovalBatch([], [], "project-1")).toBeNull();
  });

  it("skips the scope check when the inbox has no project binding", () => {
    expect(scopedApprovalBatch(inScope, [], null)).toEqual(inScope);
  });

  it("throws when a batch with rows answers for another project", () => {
    const foreign = [approvalRequest("a", "pending", { projectId: "project-2" })];
    expect(() => scopedApprovalBatch(foreign, [], "project-1")).toThrow(
      "Approval reload left the mounted project"
    );
    expect(() => scopedApprovalBatch([], foreign, "project-1")).toThrow(
      "Approval reload left the mounted project"
    );
    expect(() => scopedApprovalBatch([], [], "project-1")).not.toThrow();
  });
});
