import type { ApprovalRequestStatus, WalletApprovalRequestSummary } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  type ApprovalInboxFilters,
  EMPTY_APPROVAL_FILTERS,
  filterApprovalRequests,
  formatApprovalLabel,
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
      operationType: "wallet.transfer",
      asset: "USDC",
      amount: "25000",
      destination: "Destination11111111111111111111111111111",
      status: status === "pending" ? "pending_approval" : "completed",
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
      operationFamily: "raw_sign",
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
      filters({ walletId: "wallet-2", operationFamily: "raw_sign", apiKeyId: "key-2" })
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
});

describe("formatApprovalLabel", () => {
  it("uses the policy UI names for operation families", () => {
    expect(formatApprovalLabel("raw_sign")).toBe("Raw signing");
    expect(formatApprovalLabel("program")).toBe("Program operations");
    expect(formatApprovalLabel("provider_admin")).toBe("Provider administration");
  });

  it("formats API labels and camel case values", () => {
    expect(formatApprovalLabel("approval_required")).toBe("Approval Required");
    expect(formatApprovalLabel("pendingApproval")).toBe("Pending Approval");
  });
});
