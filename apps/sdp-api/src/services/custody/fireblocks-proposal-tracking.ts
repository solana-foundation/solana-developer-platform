import type { FireblocksProposalTracking } from "@sdp/custody/fireblocks-proposals";
import { SigningError } from "@sdp/custody/signing";
import { isFireblocksTransactionFailed } from "@sdp/types/fireblocks";
import type { DatabaseExecutor } from "@/db/client";
import {
  type FireblocksProposalScope,
  FireblocksProposalsRepository,
} from "@/db/repositories/fireblocks-proposals.repository";
import { getLogContext } from "@/runtime/logger";

export function isFireblocksSigningFinished(status: string): boolean {
  return (
    isFireblocksTransactionFailed(status) ||
    ["SIGNED", "BROADCASTING", "CONFIRMING", "COMPLETED"].includes(status)
  );
}

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
      if (!accepted && (status === "SIGNED" || status === "COMPLETED")) {
        throw new SigningError(
          "Cancellation was requested for this Fireblocks proposal",
          "INVALID_REQUEST"
        );
      }
    },
    onSigningCleanup: async ({ externalTxId }) => {
      await proposals.requestCancellation(externalTxId);
    },
  };
}
