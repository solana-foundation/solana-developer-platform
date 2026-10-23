/**
 * The signing and sponsored-submission steps every DvP transaction sender
 * shares (fund, reclaim, settle/cancel).
 *
 * Each flow signs the same way — fetch a blockhash, build a sponsored
 * fee-payer message, partially sign it with the custody signer, and refuse to
 * continue when that wallet's signature never materialized — and each submits
 * under the same claim ladder: a claim taken before the broadcast is released
 * only when the failure proves nothing was sent. The steps are spelled once
 * here so those safety properties cannot drift apart between flows.
 */

import { getRecentBlockhash, type SolanaRpc } from "@sdp/rpc/solana";
import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import type { SponsorshipFeePayment } from "@/services/sponsorship.service";
import {
  isDefiniteSubmissionError,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";

/**
 * Fetches a blockhash, builds the sponsored message, partially signs it, and
 * returns the bytes on the wire plus the signer's own signature — the key a
 * claim is taken under before anything is broadcast.
 *
 * @param input.rpc - Solana RPC for the trade's cluster.
 * @param input.sponsor - The Kora fee payer resolved from the flow's fee payment.
 * @param input.instructions - The flow's instruction list, in order.
 * @param input.signerAddress - The custody wallet (or settlement authority)
 *   whose signature must be present; a missing signature means the signer the
 *   program would accept did not sign and the transaction cannot be claimed.
 * @param input.missingSignatureError - The flow-specific message for that refusal.
 */
export async function signSponsoredDvpTransaction(input: {
  rpc: SolanaRpc;
  sponsor: Address;
  instructions: readonly Instruction[];
  signerAddress: Address;
  missingSignatureError: string;
}): Promise<{ transaction: Uint8Array; lastValidBlockHeight: bigint; signature: Signature }> {
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(input.rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.sponsor, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([...input.instructions], m)
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const signerSignatureBytes = partiallySigned.signatures[input.signerAddress];
  if (signerSignatureBytes === null || signerSignatureBytes === undefined) {
    throw new Error(input.missingSignatureError);
  }
  return {
    transaction: new Uint8Array(getTransactionEncoder().encode(partiallySigned)),
    lastValidBlockHeight,
    signature: signature(getBase58Decoder().decode(signerSignatureBytes)),
  };
}

/**
 * Submits a signed transaction under a claim, releasing the claim only when
 * the failure proves nothing was broadcast.
 *
 * `persistSigned` runs the flow's rebind (claim key → sponsored signature)
 * first, holds the sponsored signature, and only then runs `onSigned` — so a
 * rebind or bookkeeping failure inside it still reads as "the claim was never
 * rebound", which the catch treats as nothing-to-release unless the error is
 * definite. Anything ambiguous KEEPS the claim until its blockhash expires,
 * because the transaction may still land.
 *
 * @param input.claimSignature - The pre-sponsorship signature the claim was taken under.
 * @param input.rebind - Rebinds the flow's claim to the sponsored signature; throws when the claim is gone.
 * @param input.hasStarted - Whether the flow's store still holds the claim under the held signature.
 * @param input.onSigned - Post-rebind bookkeeping (the idempotency record, the audit log).
 * @param input.release - Gives the claim back when nothing was broadcast.
 * @returns The signature of the transaction that was sent, which the flow then
 *   confirms, records, or releases once a confirmation window closes.
 */
export async function submitSponsoredDvpTransaction(input: {
  feePayment: SponsorshipFeePayment;
  rpc: SolanaRpc;
  transaction: Uint8Array;
  lastValidBlockHeight: bigint;
  claimSignature: Signature;
  rebind: (sponsored: Signature) => Promise<void>;
  hasStarted: (held: Signature) => Promise<boolean>;
  onSigned?: (sponsored: Signature) => Promise<void>;
  release: (held: Signature) => Promise<void>;
}): Promise<Signature> {
  let heldSignature: Signature = input.claimSignature;
  try {
    return await submitSponsoredTransaction({
      feePayment: input.feePayment,
      rpc: input.rpc,
      transaction: input.transaction,
      lastValidBlockHeight: input.lastValidBlockHeight,
      store: {
        persistSigned: async ({ signature: sponsored }) => {
          await input.rebind(sponsored);
          heldSignature = sponsored;
          await input.onSigned?.(sponsored);
        },
        markStarted: async () => {},
        hasStarted: () => input.hasStarted(heldSignature),
        // A refused send releases its claim in the caller.
        clearSigned: async () => {},
      },
    });
  } catch (error) {
    if (heldSignature === input.claimSignature || isDefiniteSubmissionError(error)) {
      await input.release(heldSignature);
    }
    throw error;
  }
}
