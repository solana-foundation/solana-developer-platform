import { createClusterRpc } from "@sdp/rpc/factory";
import type { Blockhash } from "@solana/kit";
import { transactionFailed } from "@/lib/errors";

/** Recheck the exact approved message after slow custody signing; never silently re-sign it. */
export async function signWithFreshBlockhash<T>(input: {
  blockhash: Blockhash;
  sign: () => Promise<T>;
}): Promise<T> {
  const rpc = createClusterRpc();
  const started = performance.now();
  const signed = await input.sign();
  // Fast signatures use the fresh build's lifetime. Human approval can consume it.
  // One additional read only when signing takes at least 15 seconds.
  if (
    performance.now() - started >= 15_000 &&
    !(await rpc.isBlockhashValid(input.blockhash, { commitment: "confirmed" }).send()).value
  ) {
    throw transactionFailed(
      "This transaction expired while waiting for custody approval and was not submitted. Review payment status before creating another payment."
    );
  }
  return signed;
}
