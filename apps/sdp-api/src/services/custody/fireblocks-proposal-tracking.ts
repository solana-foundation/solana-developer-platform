import type { FireblocksProposalTracking } from "@sdp/custody/fireblocks-proposals";
import { SigningError } from "@sdp/custody/signing";
import { isFireblocksSignatureAccepted, isFireblocksSigningFinished } from "@sdp/types/fireblocks";
import type { DatabaseExecutor } from "@/db/client";
import {
  type FireblocksProposalScope,
  FireblocksProposalsRepository,
} from "@/db/repositories/fireblocks-proposals.repository";
import { getLogContext, getLogger } from "@/runtime/logger";

/** Persist before proposing; a failed write prevents any provider POST. No signing material is stored. */
export function trackFireblocksProposals(
  db: DatabaseExecutor,
  scope: FireblocksProposalScope,
  wallet: {
    connectionId: string;
    walletId: string;
    sourceAddress: string;
    accountFingerprint: string;
  }
): FireblocksProposalTracking {
  const proposals = new FireblocksProposalsRepository(db, scope);
  return {
    createExternalTxId: (request) =>
      proposals.create({ ...wallet, ...request, requestId: getLogContext().request_id }),
    onSigningStatus: async ({ externalTxId, providerTransactionId, status }) => {
      const accepted = await proposals.observe(
        externalTxId,
        providerTransactionId,
        status,
        isFireblocksSigningFinished(status)
      );
      if (!accepted && isFireblocksSignatureAccepted(status)) {
        throw new SigningError(
          "Cancellation was requested for this Fireblocks proposal",
          "INVALID_REQUEST"
        );
      }
    },
    onSigningFailure: async ({ externalTxId }) => {
      // A create the provider refused before acceptance leaves no row behind; an ambiguous
      // failure that a poll had already observed stays with reconciliation, which owns reads.
      const closed = await proposals.failUnaccepted(externalTxId);
      if (closed)
        getLogger().warn(
          { event: "sdp_fireblocks_signing_proposal_failed", proposal_id: externalTxId },
          "Fireblocks signing proposal failed before acceptance"
        );
    },
    onSigningCleanup: async ({ externalTxId }) => {
      await proposals.requestCancellation(externalTxId);
    },
  };
}
