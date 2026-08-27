import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { getPrivateTokenBalances, getPrivateTransactions } from "@heliuslabs/zolana/wallet";
import type { AssetBalance, SyncPhotonInput, SyncPhotonResult } from "@sdp/helius-rings";
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
}

export async function syncRingsWallet(
  deps: SyncDeps,
  input: SyncPhotonInput
): Promise<SyncPhotonResult> {
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

      return {
        cursor: new Date().toISOString(),
        balances: getPrivateTokenBalances(wallet).map((balance) =>
          toAssetBalance(balance.mint, balance.amount)
        ),
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
