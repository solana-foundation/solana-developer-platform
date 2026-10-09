import type { MovementId } from "@sdp/types";
import type { TransactionSigner } from "@solana/kit";
import { type MoneyAdmissionDecision, MoneyMovementRefusedError } from "@/lib/money-admission";
import { logEvent } from "@/runtime/money-path-events";

/**
 * Every way a `@solana/kit` signer produces a signature. A refused signer keeps
 * exactly the ones the real signer has, so `isTransactionSendingSigner` and the
 * other kit guards still classify it the same way.
 */
const SIGNING_METHODS = [
  "signTransactions",
  "modifyAndSignTransactions",
  "signAndSendTransactions",
  "signMessages",
  "modifyAndSignMessages",
] as const;

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
  const { reason } = decision;
  const refuse = () => {
    logEvent("warn", {
      event: "sdp_money_refused",
      surface: "signer",
      movement: context.movement,
      subject_id: context.custodyWalletId,
      organization_id: context.organizationId,
      project_id: context.projectId,
      reason,
    });
    return Promise.reject(new MoneyMovementRefusedError(reason));
  };
  const refused: Record<string, unknown> = { address: signer.address };
  for (const method of SIGNING_METHODS) {
    if (method in signer) {
      refused[method] = refuse;
    }
  }
  // SAFETY: `refused` has the real signer's address and exactly its signing
  // methods, which is all the TransactionSigner union requires of a member.
  return refused as unknown as TransactionSigner;
}
