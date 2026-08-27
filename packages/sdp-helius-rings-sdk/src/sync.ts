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
 * Reads a wallet's shielded balances from Photon.
 *
 * Always a full sync, so `input.cursor` is ignored. The SDK keeps three
 * independent read positions and warns that reaching the tip of one says
 * nothing about the others, so there is no single position to resume from and
 * pretending otherwise would silently skip rows. The returned cursor is
 * therefore an observation timestamp — when this answer was true — rather than
 * somewhere to start next time.
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
        // Photon is queried by view tag and nullifier, not by outer signature,
        // so the signatures a sync observed are the ones its rows were
        // reconstructed from.
        indexedOperationSignatures: [...new Set(transactions.map((entry) => entry.id.signature))],
        // A sync that could not read everything still returns balances, so this
        // is what stops those partial balances being read as a complete picture.
        degraded: hasSyncAnomalies(syncAnomalyCounts(report)),
      };
    }
  );
}

/**
 * Labels only the one mint whose decimals are a protocol constant.
 *
 * The port hands the SDK no asset registry, so every other mint keeps its raw
 * amount and reports no scale at all. Guessing nine decimals would render a
 * real holding at the wrong magnitude; dropping the row would report an empty
 * wallet, which is worse still. Zero used to stand in for "unknown" and was the
 * quietest wrong answer of the three — it renders the base-unit count with no
 * point and no caveat, so 1.50 USDC reads as 1500000 whole tokens. A null says
 * the scale is unknown, which is the true statement, and leaves the caller to
 * label the figure as base units.
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
