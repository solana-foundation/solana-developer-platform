import { OP_TYPES } from "@sdp/helius-rings";
import { evaluateCandidatePolicies } from "@sdp/policy";
import type { EffectiveWalletPolicy, PolicyCandidate, PolicyRule } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  buildRingsWalletOperationInput,
  RINGS_ENVELOPE_KINDS,
  ringsEnvelopeKind,
} from "./policy-envelope";

function ringsCandidate(opType: (typeof OP_TYPES)[number]): PolicyCandidate {
  return {
    organizationId: "org_1",
    projectId: "prj_1",
    custodyWalletId: "cw_1",
    walletId: "wal_1",
    apiKeyId: null,
    actor: null,
    source: "api",
    operationFamily: "transfer",
    operationType: ringsEnvelopeKind(opType),
    asset: null,
    amount: null,
    destination: null,
    context: {},
    providerExtensions: {},
  };
}

function activeWalletPolicy(rules: PolicyRule[]): EffectiveWalletPolicy {
  const now = "2026-08-17T00:00:00.000Z";
  return {
    source: "customer_profile",
    profile: {
      id: "wcp_1",
      organizationId: "org_1",
      projectId: "prj_1",
      custodyWalletId: "cw_1",
      name: "Wallet controls",
      status: "active",
      activeRevisionId: "wcpr_1",
      createdBy: "usr_1",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      archivedAt: null,
    },
    revision: {
      id: "wcpr_1",
      profileId: "wcp_1",
      revisionNumber: 1,
      rules,
      defaultAction: "allow",
      commitMessage: null,
      createdBy: "usr_1",
      createdAt: now,
      activatedAt: now,
    },
    defaultAction: "allow",
  };
}

describe("ringsEnvelopeKind", () => {
  it("covers every op type with a rings_ prefix", () => {
    expect(RINGS_ENVELOPE_KINDS).toEqual(OP_TYPES.map((opType) => `rings_${opType}`));
  });
});

describe("rings operations under wallet policy", () => {
  it("a policy denying transfers denies every rings op type — no bypass", () => {
    const denyTransfers = activeWalletPolicy([
      { kind: "operation_family", family: "transfer", action: "deny" },
    ]);

    for (const opType of OP_TYPES) {
      const evaluation = evaluateCandidatePolicies({
        candidate: ringsCandidate(opType),
        legs: [],
        walletPolicy: denyTransfers,
        apiKeyPolicy: null,
      });
      expect(evaluation.decision, `rings_${opType} escaped the transfer deny`).toBe("deny");
    }
  });

  it("a rule can target one rings op type without touching the rest", () => {
    const approveAnonymous = activeWalletPolicy([
      {
        kind: "operation_type",
        operationType: "rings_transfer_anonymous",
        action: "approval_required",
      },
    ]);

    expect(
      evaluateCandidatePolicies({
        candidate: ringsCandidate("transfer_anonymous"),
        legs: [],
        walletPolicy: approveAnonymous,
        apiKeyPolicy: null,
      }).decision
    ).toBe("approval_required");
    expect(
      evaluateCandidatePolicies({
        candidate: ringsCandidate("shield"),
        legs: [],
        walletPolicy: approveAnonymous,
        apiKeyPolicy: null,
      }).decision
    ).toBe("allow");
  });
});

describe("buildRingsWalletOperationInput", () => {
  const base = {
    organizationId: "org_1",
    projectId: "prj_1",
    custodyWalletId: "cw_1",
    sdpWalletId: "wal_1",
    apiKeyId: "key_1",
    actor: null,
    operationId: "hro_1",
    intentKey: "sha256:abc",
  };

  it("maps a transfer onto the transfer family with a rings operation type", () => {
    const input = buildRingsWalletOperationInput({
      ...base,
      operation: {
        walletId: "hrw_1",
        opType: "transfer_anonymous",
        asset: { mint: "mint_1", amountRaw: "1000" },
        to: "recipient",
        transferMode: "anonymous",
        clientNonce: "n1",
      },
    });

    expect(input).toMatchObject({
      operationFamily: "transfer",
      operationType: "rings_transfer_anonymous",
      asset: "mint_1",
      amount: "1000",
      destination: "recipient",
      idempotencyKey: "sha256:abc",
      source: "api",
    });
    expect(input.context).toMatchObject({ transferMode: "anonymous", ringsOperationId: "hro_1" });
  });

  it("marks a system-originated operation as system-sourced", () => {
    const input = buildRingsWalletOperationInput({
      ...base,
      apiKeyId: null,
      actor: null,
      operation: { walletId: "hrw_1", opType: "shield", clientNonce: "n1" },
    });

    expect(input.source).toBe("system");
    expect(input.asset).toBeNull();
    expect(input.destination).toBeNull();
  });
});
