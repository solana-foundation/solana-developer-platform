import { buildSetMergingEnabledTransaction, fetchUserRecord } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError } from "@sdp/helius-rings";
import { address } from "@solana/kit";
import { landTransaction, type ProvisionDeps } from "./provision.js";

/**
 * Merging is gated by a flag on the owner's on-chain registry record, and
 * registration does not set it: `buildRegistrationTransaction` takes no such
 * argument, so every record SDP publishes starts with merging off and the
 * merge builder refuses with WALLET_MERGE_DISABLED. Turning it on is its own
 * transaction, which is why this exists as a step rather than a field.
 *
 * SDP exposes no toggle for it. Merging is a consolidation of the owner's own
 * notes that moves no value and reveals no amount, so there is nothing for an
 * operator to decide; the flag is a protocol precondition, not a policy.
 */

export type EnsureMergingEnabledDeps = Pick<
  ProvisionDeps,
  "client" | "signTransaction" | "submitTransaction"
>;

export interface EnsureMergingEnabledResult {
  /** Absent when the record already permitted merging and nothing was sent. */
  readonly signature: string | null;
}

/**
 * Idempotent by reading first: the common call after the first one sends
 * nothing. Provisioning calls it so new wallets can merge from the start, and
 * the merge path calls it so wallets registered before this existed heal on
 * their next merge instead of needing a migration.
 */
export async function ensureRingsMergingEnabled(
  deps: EnsureMergingEnabledDeps,
  input: Readonly<{ owner: string }>
): Promise<EnsureMergingEnabledResult> {
  const owner = address(input.owner);

  const record = await fetchUserRecord({ rpc: deps.client, owner });
  if (!record) {
    // Enabling merging on an unregistered owner would land a transaction
    // against a record that does not exist. Provisioning is the step that
    // publishes it, and it is the caller's to run.
    throw new HeliusRingsError(
      "conflict",
      `no Rings user record exists for ${input.owner}; provision the wallet before enabling merging`
    );
  }
  if (record.mergingEnabled) return { signature: null };

  const transaction = await buildSetMergingEnabledTransaction({
    client: deps.client,
    owner,
    enabled: true,
  });
  const signature = await landTransaction(deps, transaction, input.owner);

  // Re-read rather than trust the send, for the same reason provisioning does:
  // confirmation says the transaction landed, not that the flag now reads true.
  // Returning here on a stale read would send the merge into the same refusal
  // this call exists to clear.
  const confirmed = await fetchUserRecord({ rpc: deps.client, owner });
  if (!confirmed?.mergingEnabled) {
    throw new HeliusRingsError(
      "gateway_unavailable",
      "the Rings user record still refuses merging after a confirmed enable"
    );
  }

  return { signature };
}
