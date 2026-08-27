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
 * this tenant's identity. A pure read with respect to the chain, but not to the
 * seed: deciding "ours" means deriving the keys in process, exactly as a sync does.
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
      // record's key fields, so what leaves is one compressed address instead of
      // the individual published halves.
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
 * Which published half, if any, is not the one this material derives. Shared
 * with provisioning so the two cannot describe the same record differently. The
 * order is part of the answer: the first difference found is the one named.
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
