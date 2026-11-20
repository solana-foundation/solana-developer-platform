import { fireblocksSigningObservation } from "@sdp/custody/fireblocks-proposals";
import type { ProposalAdapter, ProposalObservation } from "@sdp/custody/proposals";
import { z } from "zod";
import type { SigningProposalRow } from "@/db/repositories/custody-proposals.repository";
import { conflict } from "@/lib/errors";
import { transferProposalIntentSchema } from "@/services/domain/signing/admitted-proposer";
import { createOrgTransferProposalCanceller } from "@/services/solana/signer";
import type { Env } from "@/types/env";

/** Recovery capabilities cannot propose, resume a request, sign or broadcast. */
export type SigningProposalAdapter = Pick<
  ProposalAdapter<never, ProposalObservation>,
  "read" | "cancel"
>;

const fireblocksSigningBindingSchema = transferProposalIntentSchema.extend({
  sourceAddress: z.string().min(1),
});

/** Provider details are interpreted only at the adapter boundary. */
export function signingProposalAdapter(env: Env, row: SigningProposalRow): SigningProposalAdapter {
  switch (row.provider) {
    case "fireblocks": {
      const binding = fireblocksSigningBindingSchema.parse(row.binding);
      const access = () =>
        createOrgTransferProposalCanceller(
          env,
          row.organization_id,
          row.project_id,
          row.custody_wallet_id,
          binding
        );
      return {
        async read(externalId) {
          const result = await (await access()).read(externalId);
          if (result === null) return null;
          if (
            result.externalTxId !== externalId ||
            result.operation !== row.operation ||
            result.assetId !== binding.assetId ||
            result.source?.type !== "VAULT_ACCOUNT" ||
            result.source.id !== binding.vaultAccountId ||
            (row.state.providerTransactionId !== null &&
              row.state.providerTransactionId !== result.id)
          )
            throw conflict("Custody proposal identity changed");
          return fireblocksSigningObservation({
            providerTransactionId: result.id,
            status: result.status,
            subStatus: result.subStatus,
            at: new Date().toISOString(),
          });
        },
        async cancel(providerTransactionId) {
          return (await access()).cancel(providerTransactionId);
        },
      };
    }
    default:
      throw conflict(`Signing proposal recovery is unavailable for ${row.provider}`);
  }
}
