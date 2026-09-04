/**
 * Confirm-and-persist step for a broadcast deposit.
 *
 * Isolated so its failure semantics are unit-testable: once a deposit has a
 * signature, a confirmation TRANSPORT error must NOT fail it — the transaction
 * may still confirm on-chain and debit the wallet, so we leave it `submitted` and
 * let the reconciler finalize it via signature status. Only a real on-chain error
 * (`confirmation.err`) is a terminal failure.
 */

import { confirmTransaction, type SolanaRpc } from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import type { PrivateChannelDepositRepository, PrivateChannelDepositRow } from "@/db/repositories";

/**
 * Confirm a broadcast deposit on its chain and persist the outcome:
 *  - on-chain error → `failed`
 *  - confirmed      → `confirmed`
 *  - transport/timeout error → no change (stays `submitted`); returns `null`.
 *
 * Deposits stop at `confirmed` under the chain-heuristic oracle: SPC does not
 * expose an event stream, so the operator's credit into the channel is not
 * observable. `settled` becomes reachable when SPC ships events.
 */
export async function confirmAndPersistDeposit(
  repo: PrivateChannelDepositRepository,
  input: { depositId: string; rpc: SolanaRpc; signature: Signature }
): Promise<PrivateChannelDepositRow | null> {
  try {
    const confirmation = await confirmTransaction(input.rpc, input.signature, {
      commitment: "confirmed",
    });
    if (confirmation.err) {
      return repo.updateDeposit({
        id: input.depositId,
        status: "failed",
        failureReason: "Deposit transaction failed on-chain.",
        expectedStatus: "submitted",
      });
    }
    return repo.updateDeposit({
      id: input.depositId,
      status: "confirmed",
      expectedStatus: "submitted",
    });
  } catch {
    // Transport/timeout confirming — leave `submitted`; the reconciler will pick
    // it up and confirm or fail it based on the on-chain signature status.
    return null;
  }
}
