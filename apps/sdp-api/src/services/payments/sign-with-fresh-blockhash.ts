import { isBlockhashValid, type SolanaRpc } from "@sdp/rpc/solana";
import type { Blockhash } from "@solana/kit";
import { transactionFailed } from "@/lib/errors";

/** Recheck the exact approved message after slow custody signing; never silently re-sign it. */
export async function signWithFreshBlockhash<T>(input: {
  rpc: SolanaRpc;
  blockhash: Blockhash;
  sign: () => Promise<T>;
}): Promise<T> {
  const started = performance.now();
  const signed = await input.sign();
  // Fast signatures use the fresh build's lifetime. Human approval can consume it.
  // One additional read only when signing takes at least 15 seconds.
  if (
    performance.now() - started >= 15_000 &&
    !(await isBlockhashValid(input.rpc, input.blockhash, "confirmed"))
  ) {
    throw transactionFailed(
      "This transaction expired while waiting for custody approval and was not submitted. Review payment status before creating another payment."
    );
  }
  return signed;
}
