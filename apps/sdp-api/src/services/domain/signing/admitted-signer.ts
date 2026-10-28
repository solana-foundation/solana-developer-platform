import { SigningError } from "@sdp/custody/signing";
import type { MovementId } from "@sdp/types/movements";
import {
  assertIsTransactionSigner,
  isMessageModifyingSigner,
  isMessagePartialSigner,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  isTransactionSendingSigner,
  type TransactionSigner,
} from "@solana/kit";
import { custodyPolicyRefused } from "@/lib/errors";
import { assertMovementAdmitted, type MoneyAdmissionDecision } from "@/lib/money-admission";

/**
 * Rethrows a custody signing failure, as the API's `CUSTODY_POLICY_REFUSED` when the provider's
 * policy refused the signature and unchanged otherwise.
 *
 * @param error - What the custody signing call rejected with.
 * @returns Never; it always throws.
 */
function rethrowPolicyRefusal(error: unknown): never {
  if (error instanceof SigningError && error.code === "POLICY_REFUSED") {
    throw custodyPolicyRefused(error);
  }
  throw error;
}

export interface AdmittedSignerContext {
  movement: MovementId;
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
}

/**
 * The custody signer for one movement (HOO-1955, HOO-2099). Each time it is
 * asked to sign it decides admission again, from live rows, and refuses what
 * is no longer admitted: a start the organization may no longer make, or any
 * movement, exits included, the ambient credential may no longer make with
 * this wallet (revoked, out of its wallet scope). An exit never depends on the
 * organization, so a suspended one can always unwind. A flow that holds a
 * signer across slow calls (Private Channels' gateway reads, retries)
 * therefore cannot sign after a suspension or revocation landed in between.
 *
 * Deciding at signing rather than at resolution also keeps work that only
 * confirms an earlier signature working: several flows resolve a signer before
 * they know whether they still need one. The wrapper offers exactly the
 * signing kinds the real signer does, so the kit guards classify it the same.
 * It is also where a custody provider's policy refusal becomes the API's 422
 * `CUSTODY_POLICY_REFUSED` (HOO-2333), once, for every flow that signs, with
 * the provider's `SigningError` as its cause.
 */
export function admittedSigner(
  signer: TransactionSigner,
  decide: () => Promise<MoneyAdmissionDecision>,
  context: AdmittedSignerContext
): TransactionSigner {
  const admit = async () => {
    assertMovementAdmitted(await decide(), {
      surface: "signer",
      movement: context.movement,
      organizationId: context.organizationId,
      projectId: context.projectId,
      subjectId: context.custodyWalletId,
    });
  };
  const admitted = {
    address: signer.address,
    ...(isTransactionPartialSigner(signer)
      ? {
          signTransactions: async (...args: Parameters<typeof signer.signTransactions>) => {
            await admit();
            return signer.signTransactions(...args).catch(rethrowPolicyRefusal);
          },
        }
      : {}),
    ...(isTransactionModifyingSigner(signer)
      ? {
          modifyAndSignTransactions: async (
            ...args: Parameters<typeof signer.modifyAndSignTransactions>
          ) => {
            await admit();
            return signer.modifyAndSignTransactions(...args).catch(rethrowPolicyRefusal);
          },
        }
      : {}),
    ...(isTransactionSendingSigner(signer)
      ? {
          signAndSendTransactions: async (
            ...args: Parameters<typeof signer.signAndSendTransactions>
          ) => {
            await admit();
            return signer.signAndSendTransactions(...args).catch(rethrowPolicyRefusal);
          },
        }
      : {}),
    ...(isMessagePartialSigner(signer)
      ? {
          signMessages: async (...args: Parameters<typeof signer.signMessages>) => {
            await admit();
            return signer.signMessages(...args).catch(rethrowPolicyRefusal);
          },
        }
      : {}),
    ...(isMessageModifyingSigner(signer)
      ? {
          modifyAndSignMessages: async (
            ...args: Parameters<typeof signer.modifyAndSignMessages>
          ) => {
            await admit();
            return signer.modifyAndSignMessages(...args).catch(rethrowPolicyRefusal);
          },
        }
      : {}),
  };
  assertIsTransactionSigner(admitted);
  return admitted;
}
