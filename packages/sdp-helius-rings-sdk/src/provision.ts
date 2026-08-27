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
 * Registers a shielded identity on chain.
 *
 * The gateway orchestrates but never signs: the owner's Ed25519 secret lives in
 * SDP custody, so registration goes through the injected sign and submit
 * callbacks. Provisioning is idempotent because re-registering an owner re-keys
 * its published identity — the registry allows that, SDP does not, and taking it
 * would orphan every note encrypted to the old keys. Merging is a separate
 * instruction and is never enabled here.
 *
 * Two guards keep that promise, and both are needed. Reading the record first
 * is the control-flow one: it decides whether to build at all. Asserting on the
 * built bytes in {@link landTransaction} is the backstop, because the builder
 * reads the record again for itself — a record that appears between the two
 * reads turns the same call into `update_keys` and says nothing about it.
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
      // returns undefined only when a record already publishes these exact
      // keys; against one publishing different keys it builds `update_keys`
      // instead, saying nothing. Reading first is what keeps that instruction
      // out of reach, so a conflicting identity is refused rather than
      // overwritten.
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
        shieldedAddress: canonicalShieldedIdentity(material.shieldedAddress),
        materialTag: "live",
      };
    }
  );
}

/**
 * Fails closed when the published record is not the identity this material
 * derives. Repointing an owner is possible — the registry has an `update_keys`
 * instruction, and `buildRegistrationTransaction` switches to it on its own once
 * a record exists — which is why provisioning reads the record first and never
 * reaches that call on a mismatch. Taking it would orphan every note already
 * encrypted to the old keys, so a mismatch has to stop and be looked at by a
 * human.
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
      // The identity read reports the same verdict as a machine-readable code;
      // this is the one place it becomes prose, so the two cannot name
      // different fields for the same record.
      `the Rings user record for ${owner} publishes a different ${mismatch.replaceAll("_", " ")}; refusing to provision over an existing identity`
    );
  }
}

/**
 * The one user-registry instruction provisioning may sign. The program also
 * exposes `set_merging_enabled` (1) and `update_keys` (2); the last re-keys a
 * published identity, and the only thing authorizing it is the owner's Ed25519
 * signature — the old keys are never checked, so custody signing it is the
 * whole of the damage.
 */
const REGISTER_DISCRIMINATOR = 0;

/**
 * Signs through custody, broadcasts, and waits for the chain to accept it.
 *
 * The assertion is the first thing here rather than at the call site because
 * this is the single point where bytes reach `deps.signTransaction`. Guarding
 * the caller would leave a second caller free to sign whatever it built without
 * noticing there was a rule.
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
 * the code arrived here.
 *
 * `conflict`, as {@link assertRecordMatchesMaterial} raises for the sibling
 * case: nothing upstream is down, and a retry re-reads the same record and
 * builds the same instruction, so it cannot succeed. The owner is named because
 * that is what an operator has to go and look at; the instruction data is not,
 * because it is the published halves of a shielded identity.
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
 * Which user-registry instruction a built transaction would execute, or
 * `undefined` when it is not one registry instruction carrying a payload.
 *
 * The byte rather than a verdict, so the day SDP does support a deliberate
 * rotation that path asserts `update_keys` through this same decode instead of
 * writing a second one. Instructions come from
 * `getInstructionsFromCompiledTransactionMessage` rather than being indexed out
 * of the compiled message's static accounts: a v0 message may load a program
 * address from an address lookup table, and although Zolana's builder sets no
 * lookups today, an index-based read would be wrong the day it does.
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

  // Kit omits `data` rather than emptying it, so an instruction with no payload
  // reads as no discriminator here instead of as byte zero.
  return instruction.data?.[0];
}
