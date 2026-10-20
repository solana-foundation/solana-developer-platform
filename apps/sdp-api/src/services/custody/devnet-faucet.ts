import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { WalletFaucetResponse, WalletFaucetStatus } from "@sdp/types/custody";
import {
  type Address,
  commitmentComparator,
  type GetSignatureStatusesApi,
  isSolanaError,
  type RequestAirdropApi,
  type Rpc,
  type Signature,
  sol,
  solToLamports,
} from "@solana/kit";
import { forbidden, solanaRpcError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";

const DEVNET_FAUCET_LAMPORTS = solToLamports(sol("1"));

const FAUCET_CONFIRMATION_TIMEOUT_MS = 15_000;
const FAUCET_CONFIRMATION_POLL_MS = 1_000;

/**
 * Airdrops the devnet faucet amount to `walletAddress` and waits, bounded, for it to confirm, so
 * a caller that reads the balance next sees the funds. RPC: one `requestAirdrop` and one
 * `getSignatureStatuses` per poll interval that ends inside the window, 14 at most.
 *
 * @param walletAddress - The custody wallet to fund.
 * @returns The airdrop's signature, where it stood when the wait ended, and its amount.
 * @throws AppError FORBIDDEN (`faucet_devnet_only`) when the open cluster scope is not devnet.
 * @throws AppError SOLANA_RPC_ERROR when every provider refused the airdrop.
 */
export async function requestDevnetFaucetAirdrop(
  walletAddress: Address
): Promise<WalletFaucetResponse> {
  const { cluster } = currentClusterScope();
  if (cluster !== "devnet") {
    throw forbidden("The faucet funds devnet wallets only", {
      reason: "faucet_devnet_only",
      cluster,
    });
  }

  // SAFETY: the scope's cluster is devnet (checked above), whose nodes serve requestAirdrop. Kit
  // types the pooled client as the union of every cluster's client, mainnet's without the method.
  const rpc = createClusterRpc() as Rpc<GetSignatureStatusesApi & RequestAirdropApi>;
  let signature: Signature;
  try {
    signature = await rpc.requestAirdrop(walletAddress, DEVNET_FAUCET_LAMPORTS).send();
  } catch (error) {
    if (!isSolanaError(error)) throw error;
    getLogger().warn(
      { event: "wallet_faucet_airdrop_refused", solana_error_code: error.context.__code },
      "Devnet faucet refused the airdrop"
    );
    throw solanaRpcError("The devnet faucet refused the airdrop. Try again later.");
  }

  return {
    signature,
    status: await waitForAirdropConfirmation(rpc, signature),
    lamports: DEVNET_FAUCET_LAMPORTS.toString(),
  };
}

/**
 * Polls the airdrop's status once per interval until it is confirmed or failed, or the window
 * closes. A failed read is not the airdrop's outcome, so the poll goes on within the window.
 *
 * @param rpc - The scope's cluster client.
 * @param signature - The airdrop transaction.
 * @returns Where the airdrop stood when the wait ended.
 */
async function waitForAirdropConfirmation(
  rpc: Rpc<GetSignatureStatusesApi>,
  signature: Signature
): Promise<WalletFaucetStatus> {
  const deadline = Date.now() + FAUCET_CONFIRMATION_TIMEOUT_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, FAUCET_CONFIRMATION_POLL_MS));
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const abortSignal = AbortSignal.timeout(remainingMs);
    try {
      const {
        value: [status],
      } = await rpc.getSignatureStatuses([signature]).send({ abortSignal });
      if (status?.err) return "failed";
      if (
        status?.confirmationStatus &&
        commitmentComparator(status.confirmationStatus, "confirmed") >= 0
      ) {
        return "confirmed";
      }
    } catch (error) {
      if (abortSignal.aborted) break;
      getLogger().warn(
        {
          event: "wallet_faucet_confirmation_check_failed",
          error: error instanceof Error ? error.name : typeof error,
        },
        "Devnet faucet confirmation check failed"
      );
    }
  }
  return "timeout";
}
