import { evaluateCandidatePolicies } from "@sdp/policy";
import type { EffectiveWalletPolicy, PolicyCandidate } from "@sdp/types";
import { resolveComplianceVerdict } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { ComplianceProviderResult } from "@/lib/compliance";
import { resolveRiskTone } from "./payments-workspace.data";

/**
 * Regression for SOLA9-160 (APE-722): an `ok` screening with a null score and
 * an unrecognized `riskLevel` used to classify as a clean `neutral` tone, so
 * the custody destination editor's blocking predicate stayed empty and the
 * address auto-committed into an `allowlist-destinations` rule. An
 * unrecognized verdict is not a clean one — it must read as risky everywhere
 * that decides whether a screening result can pass unattended. The
 * end-to-end blocking behavior is covered against the real editor handler in
 * `use-destination-editor.risk-verdict.unit.test.tsx`.
 */

const ADDRESS = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
const CHECKED_AT = "2026-09-24T00:00:00.000Z";

function providerResult(overrides: Partial<ComplianceProviderResult>): ComplianceProviderResult {
  return {
    provider: "range",
    status: "ok",
    riskScore: null,
    evaluatedAt: CHECKED_AT,
    ...overrides,
  };
}

/** The shape the real adapters produce for the SOLA9-160 provider responses. */
const UNKNOWN_VERDICT_RESULTS = [
  providerResult({ provider: "elliptic", riskLevel: "unknown" }),
  providerResult({ provider: "range", riskLevel: "unknown" }),
  providerResult({ provider: "trm", riskLevel: "unknown" }),
];

describe("unrecognized successful compliance verdicts (SOLA9-160)", () => {
  it("never classify as a clean tone", () => {
    for (const result of UNKNOWN_VERDICT_RESULTS) {
      expect(resolveRiskTone(result)).toBe("red");
    }
  });

  it("still classify recognized verdicts as before", () => {
    expect(resolveRiskTone(providerResult({ riskScore: 9 }))).toBe("red");
    expect(resolveRiskTone(providerResult({ riskLevel: "severe" }))).toBe("red");
    expect(resolveRiskTone(providerResult({ riskScore: 3 }))).toBe("yellow");
    expect(resolveRiskTone(providerResult({ riskLevel: "moderate" }))).toBe("yellow");
    expect(resolveRiskTone(providerResult({ riskScore: 0 }))).toBe("green");
    expect(resolveRiskTone(providerResult({ riskLevel: "very low" }))).toBe("green");
    expect(
      resolveRiskTone(providerResult({ provider: "elliptic", riskLevel: "Check passed" }))
    ).toBe("green");
    // TRM's documented no-attribution response: no score, no label.
    expect(resolveRiskTone(providerResult({ provider: "trm" }))).toBe("green");
  });

  it("keep committed allowlist destinations flowing through policy", () => {
    // A destination that WAS committed (post-fix, only recognized-clean
    // results auto-commit) must still evaluate to allow.
    const evaluation = evaluateCandidatePolicies({
      candidate: candidate,
      legs: [],
      walletPolicy: activeAllowlistPolicy(ADDRESS),
      apiKeyPolicy: null,
    });
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.reason).toContain("matched policy");
  });
});

describe("resolveComplianceVerdict", () => {
  it("bands a numeric score over the label", () => {
    expect(resolveComplianceVerdict({ provider: "range", riskScore: 9, riskLevel: "low" })).toBe(
      "high"
    );
    expect(resolveComplianceVerdict({ provider: "trm", riskScore: 7, riskLevel: undefined })).toBe(
      "high"
    );
    expect(
      resolveComplianceVerdict({ provider: "range", riskScore: 3, riskLevel: undefined })
    ).toBe("medium");
    expect(
      resolveComplianceVerdict({ provider: "range", riskScore: 0, riskLevel: undefined })
    ).toBe("low");
  });

  it("keeps the documented no-score completions as pass", () => {
    expect(resolveComplianceVerdict({ provider: "elliptic", riskScore: null })).toBe("pass");
    expect(resolveComplianceVerdict({ provider: "trm", riskScore: null })).toBe("pass");
    expect(
      resolveComplianceVerdict({ provider: "elliptic", riskScore: null, riskLevel: "Check passed" })
    ).toBe("pass");
  });

  it("never reads an unrecognized label or verdictless result as clean", () => {
    for (const provider of ["elliptic", "range", "trm", "chainalysis"] as const) {
      expect(resolveComplianceVerdict({ provider, riskScore: null, riskLevel: "unknown" })).toBe(
        "unrecognized"
      );
    }
    expect(resolveComplianceVerdict({ provider: "range", riskScore: null })).toBe("unrecognized");
    // A recognized pass phrase is provider-specific contract, not universal.
    expect(
      resolveComplianceVerdict({ provider: "trm", riskScore: null, riskLevel: "check passed" })
    ).toBe("unrecognized");
  });
});

const candidate: PolicyCandidate = {
  organizationId: "org_poc",
  projectId: "project_poc",
  custodyWalletId: "wallet_poc",
  walletId: "wallet_poc",
  apiKeyId: null,
  actor: { type: "dashboard_user", id: "user_poc" },
  source: "dashboard",
  operationFamily: "payment",
  operationType: "payment_transfer_execute",
  asset: "USDC",
  amount: "10",
  destination: ADDRESS,
  context: {},
  providerExtensions: {},
};

function activeAllowlistPolicy(destination: string): EffectiveWalletPolicy {
  return {
    source: "customer_profile",
    profile: {
      id: "profile_poc",
      organizationId: "org_poc",
      projectId: "project_poc",
      custodyWalletId: "wallet_poc",
      name: "Custody controls",
      status: "active",
      activeRevisionId: "revision_poc",
      createdBy: "user_poc",
      createdAt: CHECKED_AT,
      updatedAt: CHECKED_AT,
      activatedAt: CHECKED_AT,
      archivedAt: null,
    },
    revision: {
      id: "revision_poc",
      profileId: "profile_poc",
      revisionNumber: 1,
      rules: [
        {
          id: "allowlist-destinations",
          kind: "destination",
          allowlist: [destination],
          action: "allow",
        },
      ],
      defaultAction: "review",
      commitMessage: null,
      createdBy: "user_poc",
      createdAt: CHECKED_AT,
      activatedAt: CHECKED_AT,
    },
    defaultAction: "review",
  };
}
