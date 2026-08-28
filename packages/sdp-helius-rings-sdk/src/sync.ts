import type { Wallet } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { getPrivateTokenBalances, getPrivateTransactions } from "@heliuslabs/zolana/wallet";
import type { AssetBalance, SyncPhotonInput, SyncPhotonResult } from "@sdp/helius-rings";
import { address } from "@solana/kit";
import { withConfiguredAddressErrorBridge } from "./error-bridge.js";
import {
  NATIVE_MINT_DECIMALS,
  NATIVE_MINT_SYMBOL,
  SDP_NATIVE_MINT,
  sdpMint,
} from "./flows/mint.js";
import { assertProvisionedIdentity, type ShieldedMaterialSource } from "./material.js";
import { hasSyncAnomalies, hydrateWallet, readOnlyAuthority, syncAnomalyCounts } from "./wallet.js";

/**
 * Reads a wallet's shielded balances from Photon. Always a full sync, so
 * `input.cursor` is ignored: the SDK keeps three independent read positions, and
 * the returned cursor is an observation timestamp rather than a resume point.
 */

export interface SyncDeps {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterialSource;
  readonly organizationId: string;
  readonly projectId: string;
  /**
   * The project's active custom ring. Set, balances count only notes bound to
   * this ring: an unbound note cannot move through the ring's flows, so adding
   * it in would overstate what this deployment can actually spend.
   */
  readonly ringProgramId?: string;
}

export async function syncRingsWallet(
  deps: SyncDeps,
  input: SyncPhotonInput
): Promise<SyncPhotonResult> {
  // Parsed before any material is derived: a bad configured ring is a
  // config_error whether or not the wallet exists.
  const configuredRing = deps.ringProgramId;
  const ringProgramId =
    configuredRing === undefined
      ? undefined
      : withConfiguredAddressErrorBridge(() => address(configuredRing));

  return deps.material.withMaterial(
    {
      organizationId: deps.organizationId,
      projectId: deps.projectId,
      walletId: input.walletId,
      owner: input.owner,
    },
    async (material) => {
      if (input.expectedShieldedAddress) {
        assertProvisionedIdentity(material, input.expectedShieldedAddress);
      }

      const { wallet, report } = await hydrateWallet({
        client: deps.client,
        material,
        authority: readOnlyAuthority(material),
      });
      const transactions = getPrivateTransactions(wallet);
      const balances =
        ringProgramId === undefined
          ? getPrivateTokenBalances(wallet).map((balance) =>
              toAssetBalance(balance.mint, balance.amount)
            )
          : ringBoundBalances(wallet, ringProgramId);

      return {
        cursor: new Date().toISOString(),
        balances,
        // Photon is queried by view tag and nullifier, not by outer signature, so
        // these are the signatures the returned rows were reconstructed from.
        indexedOperationSignatures: [...new Set(transactions.map((entry) => entry.id.signature))],
        // Partial balances are still returned, so this is what stops them being
        // read as a complete picture.
        degraded: hasSyncAnomalies(syncAnomalyCounts(report)),
      };
    }
  );
}

/**
 * One balance per mint over unspent notes bound to the configured ring. The
 * SDK's own balance read merges ring-bound and unbound notes, so the partition
 * has to happen here, on the reconstructed notes themselves.
 */
function ringBoundBalances(wallet: Wallet, ringProgramId: string): AssetBalance[] {
  const perMint = new Map<string, bigint>();
  for (const entry of wallet.utxos()) {
    if (entry.spent || entry.utxo.ringProgramId !== ringProgramId) {
      continue;
    }
    const mint = entry.utxo.asset;
    perMint.set(mint, (perMint.get(mint) ?? 0n) + entry.utxo.amount);
  }

  return [...perMint.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([mint, amount]) => toAssetBalance(mint, amount));
}

/**
 * Labels only the one mint whose decimals are a protocol constant, because the
 * port hands the SDK no asset registry. Null rather than zero for the rest:
 * zero renders a base-unit count as whole tokens.
 */
function toAssetBalance(reportedMint: string, amount: bigint): AssetBalance {
  const mint = sdpMint(reportedMint);
  const isNative = mint === SDP_NATIVE_MINT;

  return {
    mint,
    symbol: isNative ? NATIVE_MINT_SYMBOL : "UNKNOWN",
    decimals: isNative ? NATIVE_MINT_DECIMALS : null,
    amountRaw: amount.toString(),
  };
}
