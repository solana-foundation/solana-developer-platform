import type {
  PolicyDecision,
  WalletControlProfileRevisionHistory,
  WalletPolicyEvaluationDetail,
} from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import {
  buildPolicyAuditSearchParams,
  fetchPolicyAuditList,
  fetchPolicyEvaluationNeighbors,
  parsePolicyAuditFilters,
} from "./policy-audit.data";
import {
  decisionHeading,
  decisionLabel,
  formatRevisionReference,
  type PolicyTranslate,
  policyActor,
  providerMappingState,
  requestIdFromEvaluation,
} from "./policy-audit.shared";

const t: PolicyTranslate = (key, values) => translate(getMessages("en"), key, values);

function evaluation(
  decision: PolicyDecision,
  overrides: Partial<WalletPolicyEvaluationDetail> = {}
): WalletPolicyEvaluationDetail {
  return {
    id: `evaluation-${decision}`,
    walletOperation: {
      id: `operation-${decision}`,
      operationFamily: "payment",
      operationType: "payment_transfer",
      asset: "USDC",
      amount: "25.00",
      destination: "destination-address",
      status: decision === "deny" ? "failed" : "completed",
      createdAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z",
    },
    policyRevisions: {
      wallet: { evaluatedRevisionId: "revision-1", activeRevisionId: "revision-2" },
      apiKey: { evaluatedRevisionId: null, activeRevisionId: null },
    },
    decision,
    reasonCode: decision === "review" ? "manual_review" : "wallet_policy_match",
    reason: `${decision} decision`,
    matchedRules: [],
    evaluationContext: {
      operation: {
        id: `operation-${decision}`,
        organizationId: "organization-1",
        projectId: "project-1",
        custodyWalletId: "custody-wallet-1",
        walletId: "wallet-1",
        apiKeyId: "api-key-1",
        actor: { type: "api_key", id: "api-key-1" },
        source: "api",
        operationFamily: "payment",
        operationType: "payment_transfer",
        asset: "USDC",
        amount: "25.00",
        destination: "destination-address",
        context: { requestId: `request-${decision}` },
        idempotencyKey: null,
        createdAt: "2026-07-15T12:00:00.000Z",
      },
      walletPolicy: {
        source: "customer_profile",
        profileId: "profile-1",
        revisionId: "revision-1",
        defaultAction: "allow",
        decision,
        requiresApproval: decision === "approval_required",
      },
      apiKeyPolicy: null,
    },
    requiresApproval: decision === "approval_required",
    approvalRequestId: decision === "approval_required" ? "approval-1" : null,
    evaluatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function apiPage(
  data: WalletPolicyEvaluationDetail[],
  meta: Partial<{ total: number; page: number; pageSize: number; hasMore: boolean }> = {}
): Response {
  return Response.json({
    data,
    meta: {
      total: data.length,
      page: 1,
      pageSize: 25,
      hasMore: false,
      ...meta,
    },
  });
}

describe("policy audit data", () => {
  it("parses supported URL filters and drops malformed values", () => {
    expect(
      parsePolicyAuditFilters({
        page: "2",
        decision: "deny",
        status: "failed",
        operationFamily: "payment",
        reasonCode: " wallet_policy_match ",
        from: "2026-07-01",
        to: "2026-07-31",
      })
    ).toEqual({
      page: 2,
      decision: "deny",
      status: "failed",
      operationFamily: "payment",
      reasonCode: "wallet_policy_match",
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(parsePolicyAuditFilters({ page: "0", decision: "maybe", from: "2026-02-31" })).toEqual({
      page: 1,
      decision: undefined,
      status: undefined,
      operationFamily: undefined,
      reasonCode: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it("keeps filters in row return and pagination URLs", () => {
    expect(
      buildPolicyAuditSearchParams({
        page: 3,
        decision: "review",
        status: "pending_approval",
        operationFamily: "ramp",
        reasonCode: "manual_review",
        from: "2026-07-01",
        to: "2026-07-31",
      }).toString()
    ).toBe(
      "page=3&decision=review&status=pending_approval&operationFamily=ramp&reasonCode=manual_review&from=2026-07-01&to=2026-07-31"
    );
  });

  it("uses server pagination and filters for the normal audit list", async () => {
    const request = vi.fn(async () => apiPage([evaluation("deny")], { total: 26, page: 2 }));
    const result = await fetchPolicyAuditList(request, "wallet/one", {
      page: 2,
      decision: "deny",
      status: "failed",
      operationFamily: "payment",
      reasonCode: "wallet_policy_match",
    });

    expect(request).toHaveBeenCalledWith(
      "/v1/payments/wallets/wallet%2Fone/policies/evaluations?page=2&pageSize=25&decision=deny&status=failed&operationFamily=payment&reasonCode=wallet_policy_match"
    );
    expect(result).toMatchObject({ total: 26, page: 2, evaluations: [{ decision: "deny" }] });
  });

  it("treats SDP and provider approval decisions as one Approval required filter", async () => {
    const request = vi.fn(async (path: string) => {
      const decision = new URL(`http://sdp.local${path}`).searchParams.get("decision");
      return decision === "provider_approval_required"
        ? apiPage([
            evaluation("provider_approval_required", {
              id: "provider-approval",
              evaluatedAt: "2026-07-15T13:00:00.000Z",
            }),
          ])
        : apiPage([
            evaluation("approval_required", {
              id: "sdp-approval",
              evaluatedAt: "2026-07-15T12:00:00.000Z",
            }),
          ]);
    });

    const result = await fetchPolicyAuditList(request, "wallet-1", {
      page: 1,
      decision: "approval_required",
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.evaluations.map((item) => item.id)).toEqual([
      "provider-approval",
      "sdp-approval",
    ]);
  });

  it("applies date ranges across the filtered result, not only the visible API page", async () => {
    const request = vi.fn(async () =>
      apiPage([
        evaluation("allow", { id: "new", evaluatedAt: "2026-08-01T00:00:00.000Z" }),
        evaluation("deny", { id: "inside", evaluatedAt: "2026-07-15T12:00:00.000Z" }),
        evaluation("review", { id: "old", evaluatedAt: "2026-06-30T23:59:59.000Z" }),
      ])
    );

    const result = await fetchPolicyAuditList(request, "wallet-1", {
      page: 1,
      from: "2026-07-01",
      to: "2026-07-31",
    });

    expect(result.evaluations.map((item) => item.id)).toEqual(["inside"]);
  });

  it("bounds local date filtering for very large audit histories", async () => {
    const request = vi.fn(async (path: string) => {
      const page = Number(new URL(`http://sdp.local${path}`).searchParams.get("page"));
      return apiPage([], { total: 10_000, page, pageSize: 100, hasMore: true });
    });

    await expect(
      fetchPolicyAuditList(request, "wallet-1", {
        page: 1,
        to: "2026-07-31",
      })
    ).rejects.toThrow("Policy audit history exceeds the local filtering limit");
    expect(request).toHaveBeenCalledTimes(50);
  });

  it("computes date-filtered neighbors from one bounded history scan", async () => {
    const evaluations = Array.from({ length: 30 }, (_, index) =>
      evaluation("allow", {
        id: `evaluation-${index}`,
        evaluatedAt: new Date(Date.UTC(2026, 6, 30, 0, 0, 30 - index)).toISOString(),
      })
    );
    const request = vi.fn(async () => apiPage(evaluations));

    const result = await fetchPolicyEvaluationNeighbors(request, "wallet-1", "evaluation-24", {
      page: 1,
      from: "2026-07-01",
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      previous: { id: "evaluation-23", page: 1 },
      next: { id: "evaluation-25", page: 2 },
    });
  });

  it("returns the empty audit state without manufacturing rows", async () => {
    const result = await fetchPolicyAuditList(
      vi.fn(async () => apiPage([])),
      "wallet-1",
      {
        page: 1,
      }
    );
    expect(result).toMatchObject({ evaluations: [], total: 0, page: 1 });
  });
});

describe("policy audit presentation invariants", () => {
  it("labels allowed, blocked, approval-required, and review decisions distinctly", () => {
    expect([
      decisionLabel("allow", t),
      decisionLabel("deny", t),
      decisionLabel("approval_required", t),
      decisionLabel("review", t),
    ]).toEqual(["Allowed", "Blocked", "Approval required", "Review"]);
  });

  it("never substitutes the current active revision for the historical applied revision", () => {
    const history: WalletControlProfileRevisionHistory = {
      profile: null,
      revisions: [
        {
          id: "revision-2",
          profileId: "profile-1",
          revisionNumber: 2,
          rules: [],
          defaultAction: "deny",
          createdBy: null,
          createdAt: "2026-07-15T12:00:00.000Z",
          activatedAt: "2026-07-15T12:00:00.000Z",
          isActive: true,
        },
        {
          id: "revision-1",
          profileId: "profile-1",
          revisionNumber: 1,
          rules: [],
          defaultAction: "allow",
          createdBy: null,
          createdAt: "2026-07-14T12:00:00.000Z",
          activatedAt: "2026-07-14T12:00:00.000Z",
          isActive: false,
        },
      ],
    };
    const item = evaluation("allow");

    expect(
      formatRevisionReference(
        history,
        item.policyRevisions.wallet.evaluatedRevisionId,
        "Default allow"
      )
    ).toBe("v1");
    expect(
      formatRevisionReference(
        history,
        item.policyRevisions.wallet.activeRevisionId,
        "No active revision"
      )
    ).toBe("v2");
  });

  it("covers provider-partial, missing API-key, and legacy context states", () => {
    const partial = evaluation("review", { reasonCode: "provider_mapping_partial" });
    expect(providerMappingState(partial)).toBe("partial");

    const missingKey = policyActor(evaluation("allow"), {});
    expect(missingKey).toMatchObject({ type: "api_key", id: "api-key-1", name: null });

    const legacy = evaluation("allow", { evaluationContext: null });
    expect(requestIdFromEvaluation(legacy)).toBeNull();
  });

  it("uses the evaluated operation in the detail heading", () => {
    const rawSign = evaluation("allow", {
      walletOperation: {
        ...evaluation("allow").walletOperation,
        operationFamily: "raw_sign",
        operationType: "custody_signer_check",
      },
    });

    expect(decisionHeading(rawSign)).toBe("Raw Sign · Custody Signer Check");
  });
});
