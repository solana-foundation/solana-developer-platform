import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  buildRegistrationTransaction,
  fetchUserRecord,
  type UserRecord,
} from "@heliuslabs/zolana/wallet";
import { HeliusRingsError, type ProvisionIdentityResult } from "@sdp/helius-rings";
import {
  address,
  getBase64Codec,
  getTransactionEncoder,
  type Signature,
  type Transaction,
} from "@solana/kit";
import {
  canonicalShieldedIdentity,
  type ShieldedMaterial,
  type ShieldedMaterialSource,
} from "./material.js";

/**
 * Registers a shielded identity on chain.
 *
 * The gateway orchestrates but never signs: the owner's Ed25519 secret lives in
 * SDP custody, so registration goes through the injected sign and submit
 * callbacks. Provisioning is idempotent because re-registering is not an option:
 * a shielded identity's nullifier key cannot be rotated once published.
 */

export interface ProvisionDeps {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterialSource;
  /**
   * `owner` is passed alongside the bytes because custody has to be told which
   * key to sign with. A gateway serves every wallet in its tenant, so leaving
   * the choice to custody's default would sign the wrong wallet's transaction.
   */
  readonly signTransaction: (unsignedTxBase64: string, owner: string) => Promise<string>;
  readonly submitTransaction: (signedTxBase64: string) => Promise<string>;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface ProvisionInput {
  readonly walletId: string;
  readonly owner: string;
}

export async function provisionRingsIdentity(
  deps: ProvisionDeps,
  input: ProvisionInput
): Promise<ProvisionIdentityResult> {
  const owner = address(input.owner);

  return deps.material.withMaterial(
    {
      organizationId: deps.organizationId,
      projectId: deps.projectId,
      walletId: input.walletId,
      owner: input.owner,
    },
    async (material) => {
      // Read the record before building anything. `buildRegistrationTransaction`
      // returns undefined for an already-registered owner without saying whose
      // keys are published there, so skipping this would let a conflicting
      // identity look like a clean idempotent replay.
      let confirmed = await fetchUserRecord({ rpc: deps.client, owner });
      const signatures: string[] = [];
      if (!confirmed) {
        const registration = await buildRegistrationTransaction({
          client: deps.client,
          owner,
          address: material.shieldedAddress,
        });
        if (registration) {
          signatures.push(await landTransaction(deps, registration, input.owner));
        }

        // Re-read rather than trust what was just sent. Confirmation says the
        // transaction landed, not that the account holds what was intended.
        confirmed = await fetchUserRecord({ rpc: deps.client, owner });
      }

      if (!confirmed) {
        throw new HeliusRingsError(
          "gateway_unavailable",
          "the Rings user record is absent after a confirmed registration"
        );
      }
      assertRecordMatchesMaterial(confirmed, material, input.owner);

      return {
        identity: {
          shieldedAddress: canonicalShieldedIdentity(material.shieldedAddress),
          owner: input.owner,
        },
        registrationSignatures: signatures,
        mergingEnabled: confirmed.mergingEnabled,
        materialTag: "live",
      };
    }
  );
}

/**
 * Fails closed when the published record is not the identity this material
 * derives.
 *
 * There is no recovery path worth offering here. The SDK exposes an update
 * instruction, but using it would repoint an owner at different keys and orphan
 * every note already encrypted to the old ones, so a mismatch has to stop
 * provisioning and be looked at by a human.
 */
function assertRecordMatchesMaterial(
  record: UserRecord,
  material: ShieldedMaterial,
  owner: string
): void {
  const mismatch = firstMismatch(record, material, owner);
  if (mismatch) {
    throw new HeliusRingsError(
      "conflict",
      `the Rings user record for ${owner} publishes a different ${mismatch}; refusing to provision over an existing identity`
    );
  }
}

function firstMismatch(
  record: UserRecord,
  material: ShieldedMaterial,
  owner: string
): string | undefined {
  if (record.owner !== owner) return "owner";
  if (!sameBytes(record.nullifierPublicKey, material.nullifierKey.publicKey())) {
    return "nullifier key";
  }
  if (!sameBytes(record.viewingPublicKey, material.viewingKey.publicKey().toBytes())) {
    return "viewing key";
  }
  return undefined;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Signs through custody, broadcasts, and waits for the chain to accept it. */
async function landTransaction(
  deps: ProvisionDeps,
  transaction: Transaction,
  owner: string
): Promise<string> {
  const unsigned = getBase64Codec().decode(getTransactionEncoder().encode(transaction));
  const signed = await deps.signTransaction(unsigned, owner);
  const signature = await deps.submitTransaction(signed);

  await deps.client.confirmTransaction(signature as Signature);

  return signature;
}
