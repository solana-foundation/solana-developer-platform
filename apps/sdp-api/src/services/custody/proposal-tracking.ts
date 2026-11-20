import type { ProposalTracking } from "@sdp/custody/proposals";
import type { CustodyProvider } from "@sdp/types/custody";
import type { DatabaseExecutor } from "@/db/client";
import { createPostgresCustodyProposalsRepository } from "@/db/repositories/custody-proposals.repository.postgres";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogContext, getLogger } from "@/runtime/logger";

/** Persist before proposing; every provider shares the same lifecycle and cancellation claim. */
export function trackProposals(
  db: DatabaseExecutor,
  scope: { organizationId: string; projectId: string },
  wallet: {
    provider: CustodyProvider;
    connectionId: string;
    walletId: string;
    binding: Record<string, unknown>;
  }
): ProposalTracking {
  const proposals = createPostgresCustodyProposalsRepository(db, createTenantScope(scope));
  const identity = (proposalId: string) => ({ ...scope, proposalId });
  return {
    create: (request) =>
      proposals.createSigning({
        ...scope,
        ...wallet,
        operation: request.operation,
        binding: { ...request.binding, ...wallet.binding },
        requestId: getLogContext().request_id,
      }),
    observe: (externalId, event) => proposals.observeSigning({ ...identity(externalId), event }),
    failUnaccepted: async (externalId) => {
      if (await proposals.failUnacceptedSigning(identity(externalId))) {
        getLogger().warn(
          {
            event: "sdp_signing_proposal_failed",
            proposal_id: externalId,
            provider: wallet.provider,
          },
          "Signing proposal failed before acceptance"
        );
      }
    },
    requestCancellation: async (externalId) => {
      await proposals.requestSigningCancellation(identity(externalId));
    },
  };
}
