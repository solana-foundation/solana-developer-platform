import { describe, expect, it } from "vitest";
import { SecretRef } from "./secrets";
import type { PrivateOperation } from "./types";

describe("PrivateOperation serialization", () => {
  it("redacts every SecretRef when JSON.stringified", () => {
    const op: PrivateOperation = {
      id: "op_1",
      walletId: "hw_1",
      opType: "shield",
      state: "proving",
      approvalRequestId: null,
      policyEvaluationId: null,
      proof: {
        source: "simulated",
        ref: new SecretRef("proof-internal-secret"),
        createdAt: "2026-08-11T00:00:00Z",
      },
      outerTxSignature: null,
      photonIndexedAt: null,
      failure: null,
      input: {
        walletId: "hw_1",
        opType: "shield",
        clientNonce: "nonce_1",
      },
      intentKey: "sha256:abc",
      events: [],
      createdAt: "2026-08-11T00:00:00Z",
      updatedAt: "2026-08-11T00:00:00Z",
      retryOfOperationId: null,
    };

    const serialized = JSON.stringify(op);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("proof-internal-secret");
  });
});
