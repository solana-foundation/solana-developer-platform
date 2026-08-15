import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import {
  partiallySignTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
} from "@solana/signers";
import type { FeePaymentPort } from "@/services/ports";
import type { Env } from "@/types/env";

/**
 * Turn a provider's unsigned plan into a landed transaction, signed by an SDP
 * custody wallet.
 *
 * This is the seam the whole vault-direct model rests on: a `vault_direct`
 * provider custodies nothing and hands back instructions, so the ONLY thing
 * that moves money is SDP signing with a wallet it controls. Nothing here is
 * Kamino-specific — it consumes the neutral `EarnVaultTransactionPlan`.
 */

/** A plain-data instruction from the provider contract, back in kit form. */
function toKitInstruction(instruction: EarnVaultTransactionPlan["transactions"][number][number]) {
  return {
    programAddress: address(instruction.programAddress),
    accounts: instruction.accounts.map((account) => ({
      address: address(account.address),
      role: account.role,
    })),
    data: Uint8Array.from(Buffer.from(instruction.data, "base64")),
  } as unknown as Instruction;
}

export type VaultFeeMode =
  | { kind: "sponsored"; feePayment: FeePaymentPort }
  | { kind: "wallet-pays" };

export interface SubmitVaultPlanInput {
  plan: EarnVaultTransactionPlan;
  /** The custody wallet signer — the vault `user`, and the only real signer. */
  owner: TransactionSigner;
  rpcUrl: string;
  fee: VaultFeeMode;
}

export interface SubmitVaultPlanResult {
  signature: Signature;
}

/**
 * Decide who pays the transaction fee.
 *
 * Kora only sponsors transactions whose programs are on its allowlist, and the
 * Kamino kvault/klend programs are not on it (the Private Channels escrow hit
 * the same wall and still pays its own fee). Rather than fail at submit with an
 * opaque relay rejection, callers pass `wallet-pays` when sponsorship is not
 * available for the programs in the plan.
 *
 * NOTE the distinction that is easy to lose: klend-sdk also has a `payer`
 * concept, but that is the RENT payer for created ATAs, embedded in the
 * instruction accounts. This function is about the TRANSACTION FEE payer, which
 * is a property of the message. They are different spends and must not be
 * conflated — a sponsor that agreed to fees has not agreed to fund rent.
 */
export async function submitVaultPlan(
  env: Env,
  input: SubmitVaultPlanInput
): Promise<SubmitVaultPlanResult> {
  const batch = input.plan.transactions[0];
  if (!batch || batch.length === 0) {
    throw new Error("Vault plan carried no instructions");
  }
  if (input.plan.transactions.length > 1) {
    // Multi-transaction plans need per-leg ledger rows and a resume story; the
    // deposit path never produces one today, so refuse rather than silently
    // land only the first leg.
    throw new Error(
      `Vault plan needs ${input.plan.transactions.length} transactions; multi-transaction submission is not implemented`
    );
  }

  const instructions = batch.map(toKitInstruction);
  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");

  if (input.fee.kind === "sponsored") {
    // Sponsored: the relay's address is the fee payer and signs AFTER us, so the
    // message carries a noop signer for it and the custody wallet signs its own
    // slots only.
    const feePayer = await input.fee.feePayment.getFeePayer();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(createNoopSigner(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions(instructions, m)
    );
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    const bytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
    const signature = await input.fee.feePayment.signAndSend(bytes);
    return { signature };
  }

  // Wallet pays: the custody wallet is both the vault `user` and the fee payer,
  // so it signs once for both and we broadcast directly.
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const bytes = new Uint8Array(getTransactionEncoder().encode(signed));
  const signature = await solanaRpc.sendTransaction(rpc, bytes);
  return { signature };
}

/**
 * Simulate before signing.
 *
 * Worth the extra round trip on this path specifically: the instructions were
 * assembled by a third-party SDK against live vault state, so a stale reserve
 * set or a changed vault config surfaces here as a readable program error
 * instead of a landed, failed transaction the customer still paid for.
 */
export async function simulateVaultPlan(
  env: Env,
  input: { plan: EarnVaultTransactionPlan; owner: Address; rpcUrl: string }
): Promise<{ ok: true } | { ok: false; error: string; logs: readonly string[] }> {
  const batch = input.plan.transactions[0];
  if (!batch) return { ok: false, error: "empty plan", logs: [] };

  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(batch.map(toKitInstruction), m)
  );

  // `sigVerify: false` + `replaceRecentBlockhash` so an unsigned message can be
  // simulated: we want the PROGRAM's verdict, not a signature check.
  const compiled = await partiallySignTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(compiled);
  const result = await rpc
    .simulateTransaction(wire, {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
    })
    .send();

  if (result.value.err) {
    return {
      ok: false,
      error: JSON.stringify(result.value.err, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      ),
      logs: result.value.logs ?? [],
    };
  }
  return { ok: true };
}
