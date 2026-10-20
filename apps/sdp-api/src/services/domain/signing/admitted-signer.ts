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
import { assertMovementAdmitted, type MoneyAdmissionDecision } from "@/lib/money-admission";

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
            return signer.signTransactions(...args);
          },
        }
      : {}),
    ...(isTransactionModifyingSigner(signer)
      ? {
          modifyAndSignTransactions: async (
            ...args: Parameters<typeof signer.modifyAndSignTransactions>
          ) => {
            await admit();
            return signer.modifyAndSignTransactions(...args);
          },
        }
      : {}),
    ...(isTransactionSendingSigner(signer)
      ? {
          signAndSendTransactions: async (
            ...args: Parameters<typeof signer.signAndSendTransactions>
          ) => {
            await admit();
            return signer.signAndSendTransactions(...args);
          },
        }
      : {}),
    ...(isMessagePartialSigner(signer)
      ? {
          signMessages: async (...args: Parameters<typeof signer.signMessages>) => {
            await admit();
            return signer.signMessages(...args);
          },
        }
      : {}),
    ...(isMessageModifyingSigner(signer)
      ? {
          modifyAndSignMessages: async (
            ...args: Parameters<typeof signer.modifyAndSignMessages>
          ) => {
            await admit();
            return signer.modifyAndSignMessages(...args);
          },
        }
      : {}),
  };
  assertIsTransactionSigner(admitted);
  return admitted;
}
