/**
 * Fixtures for one shielded identity: the seed every suite derives from, the
 * material and address it produces, and the registry transactions that publish it.
 */

import { USER_REGISTRY_PROGRAM_ID } from "@heliuslabs/zolana";
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getBase64Codec,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from "@solana/kit";
import { deriveMaterial } from "../deterministic-ka/derivation.js";
import {
  canonicalShieldedIdentity,
  type MaterialRequest,
  type ShieldedMaterial,
} from "../material.js";

const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;

/**
 * A genuinely compiled transaction carrying one instruction per entry in
 * `discriminators`. Provisioning decodes what it is about to sign, so a marker
 * object cannot stand in; an `undefined` entry is kit's shape for no payload.
 */
export function compiledRegistryTransaction(
  feePayer: string,
  discriminators: readonly (number | undefined)[],
  program: string = USER_REGISTRY_PROGRAM_ID
): Transaction {
  const instructions: Instruction[] = discriminators.map((discriminator) => ({
    programAddress: program as Address,
    accounts: [{ address: feePayer as Address, role: AccountRole.WRITABLE_SIGNER }],
    ...(discriminator === undefined ? {} : { data: Uint8Array.of(discriminator) }),
  }));

  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(feePayer as Address, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
          message
        ),
      (message) => appendTransactionMessageInstructions(instructions, message)
    )
  );
}

/** The wire form provisioning hands custody, so a test can assert on it. */
export function unsignedTxBase64(transaction: Transaction): string {
  return getBase64Codec().decode(getTransactionEncoder().encode(transaction));
}

/**
 * Shared rather than copied: several suites assert against this same derivation
 * from opposite sides, and two copies could drift into disagreeing.
 */
export const TEST_SEED = new Uint8Array(32).fill(7);
export const TEST_OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const TEST_REQUEST: MaterialRequest = {
  organizationId: "org_1",
  projectId: "proj_1",
  walletId: "hrw_1",
  owner: TEST_OWNER,
};

/** Derives material, hands it to `use`, and destroys it however `use` ends. */
export async function withDerived<T>(
  use: (material: ShieldedMaterial) => T | Promise<T>,
  request: MaterialRequest = TEST_REQUEST
): Promise<T> {
  const material = await deriveMaterial(TEST_SEED, request);
  try {
    return await use(material);
  } finally {
    material.destroy();
  }
}

/** The canonical shielded identity the seed derives for a request. */
export function derivedIdentity(request: MaterialRequest = TEST_REQUEST): Promise<string> {
  return withDerived((material) => canonicalShieldedIdentity(material.shieldedAddress), request);
}

/** The published halves of one wallet's identity, as the registry stores them. */
export function publishedKeys(request: MaterialRequest = TEST_REQUEST) {
  return withDerived(
    (material) => ({
      nullifierPublicKey: material.nullifierKey.publicKey(),
      viewingPublicKey: material.viewingKey.publicKey().toBytes(),
    }),
    request
  );
}

/** A user record the seed genuinely derives, so a match is a real match. */
export async function honestRecord(
  options: { mergingEnabled?: boolean; request?: MaterialRequest } = {}
) {
  const request = options.request ?? TEST_REQUEST;
  return {
    owner: request.owner,
    ...(await publishedKeys(request)),
    mergingEnabled: options.mergingEnabled ?? false,
    bump: 255,
  };
}
