import { Wallet } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type {
  SyncReport,
  SyncWalletAuthority,
  WalletAuthority,
} from "@heliuslabs/zolana/transaction";
import { syncWallet } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError } from "@sdp/helius-rings";
import type { ShieldedMaterial } from "./material.js";

/**
 * Reading a wallet's shielded state, in the one place that decides how.
 *
 * Both callers need the same three steps — construct a `Wallet`, sync it, judge
 * the report — and differ only in what they are allowed to do with an
 * incomplete answer. Keeping that difference as one parameter here, rather than
 * as two similar blocks in `sync.ts` and `build.ts`, is what stops the spend
 * path from quietly inheriting the reporting path's tolerance.
 */

/**
 * An authority that can do nothing but hand over reading material.
 *
 * `syncWallet` is typed against the full `WalletAuthority` but only ever calls
 * `syncMaterial`, and the SDK names that narrower contract itself. Reading
 * therefore gets this: building a spending authority for a read would have
 * meant inventing an approval for an operation that does not exist. The cast is
 * to the wider parameter type, and a future SDK that really did try to spend
 * during a sync would fail loudly on a missing method rather than sign
 * something unapproved.
 */
export function readOnlyAuthority(material: ShieldedMaterial): WalletAuthority {
  const authority: SyncWalletAuthority = {
    syncMaterial: async () => ({
      identity: material.shieldedAddress,
      viewingKeys: [material.viewingKey],
      nullifierKey: material.nullifierKey,
    }),
  };

  return authority as WalletAuthority;
}

export interface HydrateWalletInput {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterial;
  /** `readOnlyAuthority` for a read; a `CustodyWalletAuthority` for a spend. */
  readonly authority: WalletAuthority;
  /**
   * Whether an incomplete read is fatal.
   *
   * True on the spend path. Note selection is only as good as the state it
   * selects from: a wallet that could not be read completely might offer a note
   * another operation already spent, or hide the one that would have covered
   * the amount. Reporting a balance can survive that and say `degraded`;
   * choosing what to spend cannot.
   */
  readonly requireComplete: boolean;
  /**
   * Slot the indexer must have reached before its answers are used.
   *
   * Photon trails the chain, so without this a read taken shortly after a
   * transaction lands describes a moment before it existed. The SDK polls until
   * the indexer reports this position, which turns a silently stale answer into
   * a slightly slower correct one.
   */
  readonly requireSlot?: bigint;
}

export interface HydratedWallet {
  readonly wallet: Wallet;
  readonly report: SyncReport;
}

export async function hydrateWallet(input: HydrateWalletInput): Promise<HydratedWallet> {
  const wallet = new Wallet({ identity: input.material.shieldedAddress });
  const report = await syncWallet({
    wallet,
    authority: input.authority,
    client: input.client,
    ...(input.requireSlot === undefined ? {} : { config: { requireSlot: input.requireSlot } }),
  });

  if (
    input.requireComplete &&
    (report.unparsedTransactions > 0 || report.undecryptableCandidates > 0)
  ) {
    throw new HeliusRingsError(
      "gateway_unavailable",
      `the wallet could not be read completely (${report.unparsedTransactions} unparsed, ${report.undecryptableCandidates} undecryptable); refusing to select notes`
    );
  }

  return { wallet, report };
}
