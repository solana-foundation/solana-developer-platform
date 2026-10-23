import type { SponsoredSubmitter } from "@sdp/solana/token-2022";
import type { MovementId } from "@sdp/types/movements";
import type { MoneyAdmissionSubject } from "@/lib/money-admission";
import { createSponsorshipFeePayment, type SponsorshipScope } from "@/services/sponsorship.service";
import {
  type SignedSubmissionStore,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";

// NOTE: issuance builds and sends its own transactions and has no row to save the sponsored
// signature on before the send, so this store records nothing (the budget ledger still holds the
// signature) and the send runs on issuance's process-default RPC (HOO-1879). Revisit when
// issuance moves onto the proper seams: a row per sponsored send, `createClusterRpc()`, and
// recovery from the saved signature like every other money path.
const UNRECORDED_SUBMISSION: SignedSubmissionStore = {
  persistSigned: async () => {},
  markStarted: async () => {},
  hasStarted: async () => false,
  clearSigned: async () => {},
};

/**
 * Issuance's fee sponsor: the sponsor's fee-payer address, and every sponsored send through
 * `submitSponsoredTransaction`, so a send refused at preflight releases its budget reservation.
 *
 * @param env - API environment for provider, database and Redis access.
 * @param scope - Who is sponsored.
 * @param movement - The movement the sponsored transactions serve.
 * @param subject - The custody wallet that signs the sponsored transactions.
 * @returns The sponsor Mosaic and the token-2022 service send through.
 */
export function createIssuanceSponsor(
  env: Env,
  scope: SponsorshipScope,
  movement: MovementId,
  subject: MoneyAdmissionSubject
): SponsoredSubmitter {
  const feePayment = createSponsorshipFeePayment(env, scope, movement, subject);
  return {
    getFeePayer: () => feePayment.getFeePayer(),
    submitSponsored: ({ transaction, lastValidBlockHeight, rpc }) =>
      submitSponsoredTransaction({
        feePayment,
        rpc,
        transaction,
        lastValidBlockHeight,
        store: UNRECORDED_SUBMISSION,
      }),
  };
}
