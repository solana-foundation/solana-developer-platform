import { SigningError } from "@sdp/custody/signing";
import type { TransactionSigner } from "@solana/kit";
import { custodyPolicyRefused } from "@/lib/errors";

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

/**
 * The custody signer with a provider policy refusal translated once, at the signer waist
 * (HOO-2333): every flow that signs through it (transfers, batches, recurring payments, Earn,
 * Private Channels, the signer check) gets the 422 `CUSTODY_POLICY_REFUSED` `AppError`, with the
 * adapter's `SigningError` as its cause. Transaction and message signing are both wrapped; a
 * signer that also sends is left alone, as {@link boundSigningTime} leaves it.
 *
 * @param signer - The custody wallet's signer.
 * @returns A signer linked to it, with its signing calls translated.
 */
export function translateCustodyPolicyRefusals(signer: TransactionSigner): TransactionSigner {
  const overrides: PropertyDescriptorMap = {};
  if ("signTransactions" in signer && typeof signer.signTransactions === "function") {
    const sign = signer.signTransactions.bind(signer);
    overrides.signTransactions = {
      value: (...args: Parameters<typeof sign>) => sign(...args).catch(rethrowPolicyRefusal),
    };
  }
  if (
    "modifyAndSignTransactions" in signer &&
    typeof signer.modifyAndSignTransactions === "function"
  ) {
    const modify = signer.modifyAndSignTransactions.bind(signer);
    overrides.modifyAndSignTransactions = {
      value: (...args: Parameters<typeof modify>) => modify(...args).catch(rethrowPolicyRefusal),
    };
  }
  if ("signMessages" in signer && typeof signer.signMessages === "function") {
    const signMessages = signer.signMessages.bind(signer);
    overrides.signMessages = {
      value: (...args: Parameters<typeof signMessages>) =>
        signMessages(...args).catch(rethrowPolicyRefusal),
    };
  }
  // SAFETY: Object.create returns an object whose prototype is the signer, so
  // it carries every member of TransactionSigner; only signing is wrapped.
  return Object.create(signer, overrides) as TransactionSigner;
}
