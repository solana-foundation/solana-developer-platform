import type { CustodyProposalState } from "@sdp/types/custody-proposals";
import { FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES } from "@sdp/types/fireblocks";
import {
  PAYMENT_TRANSFER_STATUSES_WITHOUT_EXECUTION_OUTCOME,
  type PaymentTransferStatus,
  SUCCESSFUL_PAYMENT_TRANSFER_STATUSES,
} from "@sdp/types/payments";
import { describe, expect, it } from "vitest";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { legacyFireblocksProposalState } from "./fireblocks-proposal-compatibility";

const STARTED = "2026-11-12T10:00:00.000Z";
const MISSING = "2026-11-12T10:01:00.000Z";
const ACKNOWLEDGED = "2026-11-12T10:02:00.000Z";
const ALERTED = "2026-11-12T10:03:00.000Z";
const REFUSAL = { at: STARTED, reason: "principal_revoked", message: "The key was revoked" };

function payment(
  status: PaymentTransferStatus,
  providerReference: string | null,
  providerData: Record<string, unknown>
): Pick<PaymentTransferRow, "status" | "provider_reference" | "provider_data"> {
  return { status, provider_reference: providerReference, provider_data: providerData };
}

describe("legacy Fireblocks proposal compatibility", () => {
  it.each(SUCCESSFUL_PAYMENT_TRANSFER_STATUSES)(
    "preserves %s ahead of contradictory provider failures and retains legacy facts",
    (status) => {
      expect(
        legacyFireblocksProposalState(
          payment(status, "fb-transaction", {
            fireblocksStatus: "FAILED",
            fireblocksSubStatus: "PROVIDER_FAILURE",
            fireblocksSubmissionStartedAt: STARTED,
            fireblocksFirstMissingAt: MISSING,
            proposalRefusal: REFUSAL,
            proposalCancellationAcceptedAt: ACKNOWLEDGED,
            proposalRefusalAlertedAt: ALERTED,
            unrelatedMetadata: true,
          })
        )
      ).toEqual({
        providerPhase: "completed",
        authorizationState: "committed_after_refusal",
        providerTransactionId: "fb-transaction",
        providerStatus: "FAILED",
        providerSubStatus: "PROVIDER_FAILURE",
        submissionStartedAt: STARTED,
        firstMissingAt: MISSING,
        refusal: REFUSAL,
        cancelRequestedAt: ACKNOWLEDGED,
        cancelDeclinedAt: null,
        cancelAcknowledgedAt: ACKNOWLEDGED,
        alertedAt: ALERTED,
      });
    }
  );

  it.each(FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES)(
    "retains cancellation for a failed payment with provider status %s",
    (status) => {
      const state = legacyFireblocksProposalState(
        payment("failed", null, { fireblocksStatus: status })
      );
      expect(state.providerPhase).toBe("cancelled");
    }
  );

  it("keeps a failed payment failed despite an otherwise cancellable provider state", () => {
    const state = legacyFireblocksProposalState(
      payment("failed", "fb-transaction", { fireblocksStatus: "PENDING_AUTHORIZATION" })
    );
    expect(state.providerPhase).toBe("failed");
    expect(state.authorizationState).toBe("authorized");
  });

  it.each(PAYMENT_TRANSFER_STATUSES_WITHOUT_EXECUTION_OUTCOME)(
    "uses provider progress while the legacy payment status is %s",
    (status) => {
      const state = legacyFireblocksProposalState(
        payment(status, "fb-transaction", { fireblocksStatus: "PENDING_AUTHORIZATION" })
      );
      expect(state.providerPhase).toBe("pending");
    }
  );

  const providerCases = [
    {
      name: "provider failure precedes an accepted ID and missing-read evidence",
      reference: "fb-transaction",
      data: {
        fireblocksStatus: "BLOCKED",
        fireblocksFirstMissingAt: MISSING,
        fireblocksSubmissionStartedAt: STARTED,
      },
      phase: "failed",
    },
    {
      name: "provider failure is retained without an accepted transaction ID",
      reference: null,
      data: { fireblocksStatus: "FAILED", fireblocksFirstMissingAt: MISSING },
      phase: "failed",
    },
    {
      name: "an accepted cancellable ID precedes old absence and claim markers",
      reference: "fb-transaction",
      data: {
        fireblocksStatus: "PENDING_AUTHORIZATION",
        fireblocksFirstMissingAt: MISSING,
        fireblocksSubmissionStartedAt: STARTED,
      },
      phase: "pending",
    },
    {
      name: "an accepted ID with an unfamiliar status stays observation-only",
      reference: "fb-transaction",
      data: { fireblocksStatus: "FUTURE_PROVIDER_STATUS", fireblocksFirstMissingAt: MISSING },
      phase: "executing",
    },
    {
      name: "raw provider COMPLETED alone does not replace verified payment settlement",
      reference: "fb-transaction",
      data: { fireblocksStatus: "COMPLETED" },
      phase: "executing",
    },
    {
      name: "a missing read precedes a local submission marker",
      reference: null,
      data: { fireblocksFirstMissingAt: MISSING, fireblocksSubmissionStartedAt: STARTED },
      phase: "absent",
    },
    {
      name: "a lone local submission marker remains submitting",
      reference: null,
      data: { fireblocksSubmissionStartedAt: STARTED },
      phase: "submitting",
    },
    {
      name: "no accepted or attempted evidence remains unsent",
      reference: null,
      data: {},
      phase: "unsent",
    },
  ] as const satisfies readonly {
    name: string;
    reference: string | null;
    data: Record<string, unknown>;
    phase: CustodyProposalState["providerPhase"];
  }[];

  it.each(providerCases)("$name", ({ reference, data, phase }) => {
    expect(
      legacyFireblocksProposalState(payment("processing", reference, data)).providerPhase
    ).toBe(phase);
  });

  it("does not infer a refusal from cancellation acknowledgment alone", () => {
    const state = legacyFireblocksProposalState(
      payment("processing", "fb-transaction", {
        fireblocksStatus: "PENDING_AUTHORIZATION",
        proposalCancellationAcceptedAt: ACKNOWLEDGED,
      })
    );
    expect(state.authorizationState).toBe("authorized");
    expect(state.refusal).toBeNull();
    expect(state.cancelRequestedAt).toBe(ACKNOWLEDGED);
  });

  it("preserves a recorded refusal without inventing a cancellation acknowledgment", () => {
    const state = legacyFireblocksProposalState(
      payment("processing", "fb-transaction", {
        fireblocksStatus: "PENDING_AUTHORIZATION",
        proposalRefusal: REFUSAL,
      })
    );
    expect(state.authorizationState).toBe("refused");
    expect(state.refusal).toEqual(REFUSAL);
    expect(state.cancelAcknowledgedAt).toBeNull();
  });

  it("retains acknowledged cancellation even after a provider failure", () => {
    const state = legacyFireblocksProposalState(
      payment("failed", "fb-transaction", {
        fireblocksStatus: "FAILED",
        proposalRefusal: REFUSAL,
        proposalCancellationAcceptedAt: ACKNOWLEDGED,
      })
    );
    expect(state.providerPhase).toBe("failed");
    expect(state.authorizationState).toBe("cancel_acknowledged");
    expect(state.cancelRequestedAt).toBe(ACKNOWLEDGED);
    expect(state.cancelAcknowledgedAt).toBe(ACKNOWLEDGED);
  });

  it("continues to reject malformed durable refusal and timestamp facts", () => {
    expect(() =>
      legacyFireblocksProposalState(payment("processing", null, { proposalRefusal: {} }))
    ).toThrow();
    expect(() =>
      legacyFireblocksProposalState(
        payment("processing", null, { fireblocksFirstMissingAt: "not-a-timestamp" })
      )
    ).toThrow();
  });
});
