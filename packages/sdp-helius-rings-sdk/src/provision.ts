import { USER_REGISTRY_PROGRAM_ID } from "@heliuslabs/zolana";
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
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getTransactionEncoder,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { firstMismatch } from "./identity.js";
import {
  canonicalShieldedIdentity,
  type ShieldedMaterial,
  type ShieldedMaterialSource,
} from "./material.js";

/**
 * Registers a shielded identity, signing only through custody. Reading the
 * record first keeps the registry's `update_keys` out of reach; the assertion in
 * {@link landTransaction} is the backstop, because the builder re-reads it.
 */

export interface ProvisionDeps {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterialSource;
  /** `owner` names the key custody must sign with; a gateway serves a whole tenant. */
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
      // Read the record before building anything: against one publishing
      // different keys, `buildRegistrationTransaction` silently builds
      // `update_keys` instead.
      let confirmed = await fetchUserRecord({ rpc: deps.client, owner });
      if (!confirmed) {
        const registration = await buildRegistrationTransaction({
          client: deps.client,
          owner,
          address: material.shieldedAddress,
        });
        if (registration) {
          await landTransaction(deps, registration, input.owner);
        }

        // Confirmation says the transaction landed, not that the account holds
        // what was intended.
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
        shieldedAddress: canonicalShieldedIdentity(material.shieldedAddress),
        materialTag: "live",
      };
    }
  );
}

/**
 * Fails closed when the published record is not the identity this material
 * derives. The registry's `update_keys` path would take it, and that would
 * orphan every note already encrypted to the old keys.
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
      // The one place the identity read's machine-readable verdict becomes prose.
      `the Rings user record for ${owner} publishes a different ${mismatch.replaceAll("_", " ")}; refusing to provision over an existing identity`
    );
  }
}

/**
 * The one user-registry instruction provisioning may sign. Instruction 2,
 * `update_keys`, re-keys a published identity and is authorized by the owner's
 * signature alone, so custody signing it is the whole of the damage.
 */
const REGISTER_DISCRIMINATOR = 0;

/**
 * Signs through custody, broadcasts, and waits for the chain to accept it. The
 * assertion sits here rather than at the call site because this is the single
 * point where bytes reach `deps.signTransaction`.
 */
async function landTransaction(
  deps: ProvisionDeps,
  transaction: Transaction,
  owner: string
): Promise<void> {
  assertRegistersIdentity(transaction, owner);

  const unsigned = getBase64Codec().decode(getTransactionEncoder().encode(transaction));
  const signed = await deps.signTransaction(unsigned, owner);
  const signature = await deps.submitTransaction(signed);

  await deps.client.confirmTransaction(signature as Signature);
}

/**
 * Refuses anything but a registration, judged on the bytes rather than on how
 * the code arrived here. The owner is named because that is what an operator has
 * to look at; the instruction data is not, because it publishes identity halves.
 */
function assertRegistersIdentity(transaction: Transaction, owner: string): void {
  if (registryDiscriminatorOf(transaction) !== REGISTER_DISCRIMINATOR) {
    throw new HeliusRingsError(
      "conflict",
      `refusing to sign a transaction for ${owner} that is not the Rings registry's register instruction; it could re-key an already-published shielded identity`
    );
  }
}

/**
 * Which registry instruction a built transaction would execute, or `undefined`
 * when it is not one registry instruction with a payload. Read via the decoder,
 * not the static accounts: a v0 message may load a program from a lookup table.
 */
function registryDiscriminatorOf(transaction: Transaction): number | undefined {
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const instructions = getInstructionsFromCompiledTransactionMessage(message);
  if (instructions.length !== 1) {
    return undefined;
  }

  const [instruction] = instructions;
  if (instruction.programAddress !== USER_REGISTRY_PROGRAM_ID) {
    return undefined;
  }

  // Kit omits `data` rather than emptying it, so no payload reads as no discriminator.
  return instruction.data?.[0];
}
