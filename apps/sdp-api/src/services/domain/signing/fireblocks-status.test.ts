import {
  FIREBLOCKS_FAILED_TRANSACTION_STATUSES,
  FIREBLOCKS_SIGNING_PROPOSAL_STATUSES,
  isFireblocksProposalCancellable,
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
  isFireblocksTransactionFailed,
} from "@sdp/types/fireblocks";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";

// Provider states: https://developers.fireblocks.com/reference/transaction-statuses
describe("Fireblocks cancellation states", () => {
  it.each([
    "SUBMITTED",
    "QUEUED",
    "PENDING_AML_SCREENING",
    "PENDING_SIGNATURE",
    "PENDING_3RD_PARTY_MANUAL_APPROVAL",
    "PENDING_3RD_PARTY",
    "PENDING_AUTHORIZATION",
    "PENDING_ENRICHMENT",
  ])("offers a cancellation request in the pre-broadcast state %s", (status) => {
    expect(isFireblocksTransactionCancellable(status)).toBe(true);
    expect(isFireblocksProposalCancellable(status)).toBe(true);
  });

  it.each(FIREBLOCKS_FAILED_TRANSACTION_STATUSES)(
    "never offers a cancellation request in the terminal state %s",
    (status) => {
      expect(isFireblocksTransactionCancellable(status)).toBe(false);
      expect(isFireblocksProposalCancellable(status)).toBe(false);
    }
  );

  it.each(["SIGNED", "BROADCASTING", "COMPLETED", "CANCELLING", "UNKNOWN_STATE", ""])(
    "never offers a cancellation request in %s",
    (status) => {
      expect(isFireblocksTransactionCancellable(status)).toBe(false);
      expect(isFireblocksProposalCancellable(status)).toBe(false);
    }
  );
});

describe("Fireblocks cancellation verdicts", () => {
  it.each(["CANCELLED", "CANCELED"])(
    "recognizes the provider spelling %s as a terminal failed cancellation",
    (status) => {
      expect(isFireblocksTransactionCancelled(status)).toBe(true);
      expect(isFireblocksTransactionFailed(status)).toBe(true);
    }
  );

  it.each(["CANCELLING", "PENDING_SIGNATURE", "COMPLETED", "UNKNOWN_STATE"])(
    "does not mistake %s for a terminal cancellation",
    (status) => expect(isFireblocksTransactionCancelled(status)).toBe(false)
  );
});

describe("Fireblocks signing proposal storage", () => {
  it("keeps the deployed status CHECK equal to the signing proposal status set", async () => {
    const constraint = required(
      await getDb(env).queryOne<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'fireblocks_signing_proposals'::regclass
           AND conname = 'fireblocks_signing_proposals_status_check'`
      )
    );
    const statuses = required(constraint.definition.match(/'[^']+'/g)).map((value) =>
      value.slice(1, -1)
    );
    expect(statuses.sort()).toEqual([...FIREBLOCKS_SIGNING_PROPOSAL_STATUSES].sort());
  });
});
