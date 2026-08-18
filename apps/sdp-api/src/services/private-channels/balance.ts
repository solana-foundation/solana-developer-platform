/**
 * Channel balance read.
 *
 * Balances live at the SPC layer, one per (wallet, mint), derived by reading the
 * owner's classic-Token ATA through the gateway. Logical channels are labels, so
 * a wallet in multiple channels shows the SAME balance in each — never
 * materialize a per-channel balance.
 *
 * The connection comes from the project's ACTIVE persisted instance (loaded by
 * the caller and passed in), matching the config-in pattern used by the rest of
 * this service. The transport (`createChannelGatewayRpc`/`getChannelTokenBalance`)
 * is config-source-agnostic.
 */

import { getChannelTokenBalance } from "@sdp/private-channels";
import { assertValidAddress } from "@sdp/solana/address";
import type { PrivateChannelBalance, PrivateChannelInstance } from "@sdp/types";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import type { Env } from "@/types/env";
import { type SpcAuthContext, withGatewayRpc } from "./auth/gateway-auth";
import { inferCluster, knownMintToken, resolveChannelToken } from "./mint";

/** The instance fields the balance read needs: gateway URL + a cluster hint. */
type BalanceInstance = Pick<PrivateChannelInstance, "gatewayUrl" | "chainRpcUrl">;

/**
 * Read an owner's channel token balance through the gateway → wire DTO.
 *
 * `auth` is the SPC auth context for gateway reads (see `./auth/gateway-auth`).
 * Required — the gateway JWT-gates balance reads.
 */
export async function getChannelBalance(
  env: Env,
  {
    instance,
    owner,
    mint,
    auth,
  }: { instance: BalanceInstance; owner: string; mint?: string; auth: SpcAuthContext }
): Promise<PrivateChannelBalance> {
  const cluster = inferCluster(instance.chainRpcUrl);
  const ownerAddress = assertValidAddress(owner, "owner");
  const mintAddress = assertValidAddress(mint ?? resolveChannelToken(cluster).mint, "mint");

  // This stays a GENERAL read: an explicitly-passed mint need not be on the
  // instance's allowlist, unlike the write paths. The allowlist only supplies the
  // default. A mint the catalogue does not know falls back to classic SPL, which
  // is what every mint outside the catalogue is today.
  const knownMint = knownMintToken(mintAddress, cluster);
  const tokenProgram = assertValidAddress(
    knownMint?.tokenProgram ?? SPL_TOKEN_PROGRAMS["spl-token"],
    "tokenProgram"
  );

  const { tokenAccount, balance } = await withGatewayRpc(env, instance.gatewayUrl, auth, (rpc) =>
    getChannelTokenBalance(rpc, ownerAddress, mintAddress, tokenProgram)
  );

  // A missing token account is a zero balance; fall back to the mint's known
  // decimals so the DTO stays accurate even before the owner is first credited.
  const decimals = balance?.decimals ?? knownMint?.decimals ?? 0;
  return {
    owner: ownerAddress,
    mint: mintAddress,
    tokenAccount,
    amount: balance?.amount ?? "0",
    decimals,
    uiAmount: balance?.uiAmountString ?? "0",
  };
}
