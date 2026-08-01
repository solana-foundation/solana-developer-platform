/**
 * Confirm-and-persist step for a broadcast withdrawal burn.
 *
 * Isolated so its failure semantics are unit-testable. The burn is broadcast to
 * the GATEWAY (the channel chain), so confirmation reads the gateway too. Failure
 * semantics mirror deposits but with the withdrawal-specific invariant:
 *  - a confirmation TRANSPORT error (network/timeout — OR the gateway rejecting
 *    the read without a JWT) must NOT change state: leave the withdrawal
 *    `submitted` and let the reconciler finalize it. Returns `null`.
 *  - a real on-chain burn error (`confirmation.err`) is a terminal `failed` — this
 *    is a PRE-burn-confirmation failure, so `failed` is legitimate here (no balance
 *    moved). After `confirmed` the reconciler NEVER auto-fails (the balance is
 *    already gone → operator alert instead).
 *  - confirmed → `confirmed` (authoritative: the user's channel balance is gone;
 *    the oracle drives `confirmed → settled` once it observes the operator's
 *    devnet release).
 */

import * as solanaRpc from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import type {
  PrivateChannelWithdrawalRepository,
  PrivateChannelWithdrawalRow,
} from "@/db/repositories";
import type { Env } from "@/types/env";
import { type SpcAuthContext, withGatewayRpc } from "./auth/gateway-auth";

/**
 * Confirm a broadcast burn on the gateway (channel chain) and persist the outcome:
 *  - on-chain burn error → `failed`
 *  - confirmed           → `confirmed`
 *  - transport/auth/timeout error → no change (stays `submitted`); returns `null`.
 */
export async function confirmAndPersistWithdrawal(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  input: {
    withdrawalId: string;
    gatewayUrl: string;
    signature: Signature;
    /** SPC auth context — the gateway JWT-gates signature reads. */
    gatewayAuth: SpcAuthContext;
  }
): Promise<PrivateChannelWithdrawalRow | null> {
  try {
    const confirmation = await withGatewayRpc(
      env,
      input.gatewayUrl,
      input.gatewayAuth,
      (gatewayRpc) =>
        solanaRpc.confirmTransaction(gatewayRpc, input.signature, { commitment: "confirmed" })
    );
    if (confirmation.err) {
      return repo.updateWithdrawal({
        id: input.withdrawalId,
        status: "failed",
        failureReason: "Withdrawal burn failed on-chain.",
        expectedStatus: "submitted",
      });
    }
    return repo.updateWithdrawal({
      id: input.withdrawalId,
      status: "confirmed",
      expectedStatus: "submitted",
    });
  } catch {
    // Transport/timeout — or the gateway declining the read without a JWT. Leave
    // `submitted`; the reconciler finalizes it from the on-chain signature status.
    return null;
  }
}
