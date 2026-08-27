import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  fetchUserRecord,
  resolvedAddressFromRecord,
  type UserRecord,
} from "@heliuslabs/zolana/wallet";
import type {
  ReadIdentityInput,
  ReadIdentityResult,
  RingsIdentityMismatch,
} from "@sdp/helius-rings";
import { address } from "@solana/kit";
import {
  canonicalShieldedIdentity,
  type ShieldedMaterial,
  type ShieldedMaterialSource,
} from "./material.js";

/**
 * Reads what the user registry publishes for an owner and says whether it is
 * this tenant's identity.
 *
 * The honest caveat: this is a pure read *with respect to the chain* — one
 * account read, no transaction built, nothing signed, no fee — but it is not a
 * read with respect to the seed. Deciding "ours" versus "foreign" means having
 * the derived keys to compare against, so the material is derived in process
 * exactly as `syncRingsWallet` already derives it. It is precisely as
 * seed-dependent as a sync, and no less.
 *
 * It exists because an operator who hits a provisioning conflict otherwise has
 * no way to see what is actually published short of decoding the PDA by hand.
 */

export interface ReadIdentityDeps {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterialSource;
  readonly organizationId: string;
  readonly projectId: string;
}

export async function readRingsIdentityStatus(
  deps: ReadIdentityDeps,
  input: ReadIdentityInput
): Promise<ReadIdentityResult> {
  const owner = address(input.owner);

  return deps.material.withMaterial(
    {
      organizationId: deps.organizationId,
      projectId: deps.projectId,
      walletId: input.walletId,
      owner: input.owner,
    },
    async (material) => {
      const derivedShieldedAddress = canonicalShieldedIdentity(material.shieldedAddress);
      const record = await fetchUserRecord({ rpc: deps.client, owner });

      if (!record) {
        return {
          status: "unregistered",
          derivedShieldedAddress,
          publishedShieldedAddress: null,
          mismatch: null,
        };
      }

      // Canonicalised through the SDK's own resolver rather than by reading the
      // record's key fields. Both paths would reach the same commitment, but
      // only this one keeps the individual published halves out of every frame
      // between here and the response: what leaves is one compressed address,
      // the same class of value already stored as a wallet's shielded address.
      const publishedShieldedAddress = canonicalShieldedIdentity(
        resolvedAddressFromRecord(owner, record).address
      );
      const mismatch = firstMismatch(record, material, input.owner);

      return {
        status: mismatch ? "foreign" : "ours",
        derivedShieldedAddress,
        publishedShieldedAddress,
        mismatch: mismatch ?? null,
      };
    }
  );
}

/**
 * Which published half, if any, is not the one this material derives.
 *
 * Shared with provisioning rather than reimplemented there: provisioning
 * refuses a conflicting record on this answer and this read reports it, so a
 * second copy would let the two describe the same record differently. The order
 * is part of the answer — the first difference found is the one named.
 */
export function firstMismatch(
  record: UserRecord,
  material: ShieldedMaterial,
  owner: string
): RingsIdentityMismatch | undefined {
  if (record.owner !== owner) return "owner";
  if (!sameBytes(record.nullifierPublicKey, material.nullifierKey.publicKey())) {
    return "nullifier_key";
  }
  if (!sameBytes(record.viewingPublicKey, material.viewingKey.publicKey().toBytes())) {
    return "viewing_key";
  }
  return undefined;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
