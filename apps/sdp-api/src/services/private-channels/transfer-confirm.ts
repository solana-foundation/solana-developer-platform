/**
 * Confirm-and-persist step for a broadcast member-to-member transfer.
 *
 * Isolated so its failure semantics are unit-testable, and split out for the same
 * reason as `withdraw-confirm`. The transfer executes inside SPC, so confirmation
 * reads SPC through the gateway.
 *
 * Why a confirm read is required at all: `sendTransaction` does NOT execute. SPC
 * validates the encoding and program allowlist, pushes the transaction onto the
 * write pipeline's ingress queue and returns the signature. Execution happens
 * downstream (dedup → sigverify → sequencer → execution), where it can return a
 * transaction error, and where dedup silently DROPS a transaction whose blockhash
 * has aged out of the live window or whose signature it has already seen. Neither
 * outcome is reported back to the submitter, so `submitted` on its own asserts
 * nothing about whether value actually moved.
 *
 * Why ONE read is enough: SPC runs a single sequencer with no fork choice, so
 * `getSignatureStatuses` reports `Finalized` for every transaction it can see and
 * commitment levels are accepted-then-discarded. The first sighting is the final
 * answer — there is no deeper commitment to wait for and no reorg to walk back.
 * That makes `confirmed` terminal here, unlike deposits and withdrawals where an
 * oracle still has to observe the mainnet leg.
 *
 * Failure semantics:
 *  - execution error (`confirmation.err`) → terminal `failed`, carrying the real
 *    transaction error. Nothing moved, so the user can retry.
 *  - transport error, or a timeout because the transaction was silently dropped →
 *    no state change: the row stays `submitted` and returns `null`. There is no
 *    reconciler for transfers, so a lingering `submitted` is the operator signal
 *    that a submission never produced a verdict. Claiming `confirmed` here would
 *    be the exact false assertion this step exists to remove, and claiming
 *    `failed` would be just as wrong — a slow read does not mean nothing landed.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import type {
  PrivateChannelTransferRepository,
  PrivateChannelTransferRow,
} from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { type SpcAuthContext, withGatewayRpc } from "./auth/gateway-auth";
import { describeTransactionErr } from "./tx-error";

/**
 * Bound the confirm read well below the 60s default used for the mainnet-facing
 * deposit/withdrawal legs. SPC executes in milliseconds, so the only way to reach
 * this ceiling is a transaction that will never appear (a dedup drop) — and a user
 * is waiting on this request, so it must not hang for a minute to learn that.
 */
const TRANSFER_CONFIRM_TIMEOUT_MS = 5_000;
const TRANSFER_CONFIRM_POLL_INTERVAL_MS = 250;

/**
 * Confirm an accepted transfer against SPC and persist the outcome:
 *  - execution error → `failed` (with the transaction error)
 *  - executed cleanly → `confirmed` (terminal)
 *  - transport error / never appeared → no change (stays `submitted`); returns `null`.
 */
export async function confirmAndPersistTransfer(
  env: Env,
  repo: PrivateChannelTransferRepository,
  input: {
    transferId: string;
    gatewayUrl: string;
    signature: Signature;
    /** SPC auth context — the gateway JWT-gates signature reads. */
    gatewayAuth: SpcAuthContext;
  }
): Promise<PrivateChannelTransferRow | null> {
  try {
    const confirmation = await withGatewayRpc(
      env,
      input.gatewayUrl,
      input.gatewayAuth,
      (gatewayRpc) =>
        solanaRpc.confirmTransaction(gatewayRpc, input.signature, {
          timeoutMs: TRANSFER_CONFIRM_TIMEOUT_MS,
          pollIntervalMs: TRANSFER_CONFIRM_POLL_INTERVAL_MS,
        })
    );
    if (confirmation.err) {
      return repo.updateTransfer({
        id: input.transferId,
        status: "failed",
        failureReason: describeTransactionErr(
          confirmation.err,
          "Transfer failed during execution."
        ),
        expectedStatus: "submitted",
      });
    }
    return repo.updateTransfer({
      id: input.transferId,
      status: "confirmed",
      expectedStatus: "submitted",
    });
  } catch (error) {
    getLogger().error(
      {
        transferId: input.transferId,
        signature: input.signature,
        error: error instanceof Error ? error.message : error,
      },
      "private-channel-transfer confirm produced no verdict"
    );
    return null;
  }
}
