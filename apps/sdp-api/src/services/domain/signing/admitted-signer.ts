import type { MovementId } from "@sdp/types";
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
 * The custody signer for one movement (HOO-1955). Admission is decided from the
 * organization's state when the signer is resolved and enforced when it signs:
 * an admitted movement gets the provider's signer unchanged, and a refused one
 * gets a signer whose every signing method refuses.
 *
 * Refusing at signing rather than at resolution keeps work that only confirms
 * an earlier signature working: several flows resolve a signer before they know
 * whether they still need one. Nothing else about the real signer is copied,
 * so a refused signer cannot be used for anything but its address.
 */
export function admittedSigner(
  signer: TransactionSigner,
  decision: MoneyAdmissionDecision,
  context: AdmittedSignerContext
): TransactionSigner {
  if (decision.admitted) {
    return signer;
  }
  const refuse = async () => {
    assertMovementAdmitted(decision, {
      surface: "signer",
      movement: context.movement,
      organizationId: context.organizationId,
      projectId: context.projectId,
      subjectId: context.custodyWalletId,
    });
  };
  // Exactly the kinds of signing the real signer offers, each refusing, so the
  // kit guards classify the refused signer as they would the real one.
  const refused = {
    address: signer.address,
    ...(isTransactionPartialSigner(signer) ? { signTransactions: refuse } : {}),
    ...(isTransactionModifyingSigner(signer) ? { modifyAndSignTransactions: refuse } : {}),
    ...(isTransactionSendingSigner(signer) ? { signAndSendTransactions: refuse } : {}),
    ...(isMessagePartialSigner(signer) ? { signMessages: refuse } : {}),
    ...(isMessageModifyingSigner(signer) ? { modifyAndSignMessages: refuse } : {}),
  };
  assertIsTransactionSigner(refused);
  return refused;
}
