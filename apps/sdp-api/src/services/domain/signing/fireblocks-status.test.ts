import {
  FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES,
  FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES,
  FIREBLOCKS_FAILED_TRANSACTION_STATUSES,
  FIREBLOCKS_SIGNING_PROPOSAL_STATUSES,
  isFireblocksProposalCancellable,
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
} from "@sdp/types/fireblocks";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { env } from "@/test/helpers/env";

describe("Fireblocks cancellation states", () => {
  it.each(FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES)(
    "permits a best-effort cancellation request in %s",
    (status) => {
      expect(isFireblocksTransactionCancellable(status)).toBe(true);
      expect(isFireblocksProposalCancellable(status)).toBe(true);
    }
  );

  it.each(FIREBLOCKS_FAILED_TRANSACTION_STATUSES)("never cancels terminal %s again", (status) => {
    expect(isFireblocksTransactionCancellable(status)).toBe(false);
    expect(isFireblocksProposalCancellable(status)).toBe(false);
  });

  it.each(["BROADCASTING", "CONFIRMING", "COMPLETED", "CANCELLING", "UNKNOWN_STATE", ""])(
    "never infers cancellation safety from %s",
    (status) => {
      expect(isFireblocksTransactionCancellable(status)).toBe(false);
      expect(isFireblocksProposalCancellable(status)).toBe(false);
    }
  );
});

describe("Fireblocks cancellation verdicts", () => {
  it.each(FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES)("recognizes terminal %s", (status) => {
    expect(isFireblocksTransactionCancelled(status)).toBe(true);
  });

  it.each(["CANCELLING", "PENDING_SIGNATURE", "COMPLETED", "UNKNOWN_STATE"])(
    "does not mistake %s for a terminal cancellation",
    (status) => expect(isFireblocksTransactionCancelled(status)).toBe(false)
  );
});

describe("Fireblocks signing proposal storage", () => {
  it("keeps runtime cancellation changes separate from the deployed status CHECK", async () => {
    const constraint = await getDb(env).queryOne<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'fireblocks_signing_proposals'::regclass
         AND conname = 'fireblocks_signing_proposals_status_check'`
    );
    const statuses = constraint?.definition.match(/'[^']+'/g)?.map((value) => value.slice(1, -1));
    expect([...FIREBLOCKS_SIGNING_PROPOSAL_STATUSES].sort()).toEqual(statuses?.sort());
  });
});
