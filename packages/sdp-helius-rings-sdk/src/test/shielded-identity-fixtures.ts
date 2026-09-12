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
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getBase58Codec,
  getBase64Codec,
  getTransactionEncoder,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  type Transaction,
} from "@solana/kit";
import {
  createCustodyMaterialSource,
  fetchDerivationSeed,
  type SignMessage,
} from "../custody-ka/index.js";
import {
  canonicalShieldedIdentity,
  createShieldedMaterial,
  type MaterialRequest,
  publishedHalves,
  type ShieldedMaterial,
  type ShieldedMaterialSource,
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
 * A fixed custody key stands in for Turnkey.
 *
 * Ed25519 signing is deterministic, so a fixed secret gives a fixed signature and
 * therefore a fixed shielded identity — every golden value stays as stable as it
 * was under the old constant seed. What changes is that the fixture now runs the
 * real path: a genuine signature over the real derivation message, verified by
 * Zolana on the way in. Fabricated bytes cannot stand in any more.
 */
export const TEST_SIGNER_SECRET = new Uint8Array(32).fill(7);

/** A second custody key, for the foreign identity every isolation test needs. */
export const TEST_OTHER_SIGNER_SECRET = new Uint8Array(32).fill(9);

/**
 * The addresses those secrets derive. Hardcoded so suites can build a request at
 * module scope; `shielded-identity-fixtures.test.ts` asserts the keypairs still
 * produce them, so the two cannot drift apart silently.
 *
 * Since the derivation root is the owner key alone, a *different owner* is now
 * the only way to get a different shielded identity — varying the organization,
 * project or wallet id no longer changes the keys.
 */
export const TEST_OWNER = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
export const TEST_OTHER_OWNER = "J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf";

export const TEST_REQUEST: MaterialRequest = {
  organizationId: "org_1",
  projectId: "proj_1",
  walletId: "hrw_1",
  owner: TEST_OWNER,
};

/** The same tenant, a different owner — so a genuinely different identity. */
export const TEST_FOREIGN_REQUEST: MaterialRequest = {
  ...TEST_REQUEST,
  walletId: "hrw_someone_else",
  owner: TEST_OTHER_OWNER,
};

const signers = new Map<Uint8Array, Promise<KeyPairSigner>>();

function signerFor(secret: Uint8Array): Promise<KeyPairSigner> {
  const existing = signers.get(secret);
  if (existing) return existing;
  const created = createKeyPairSignerFromPrivateKeyBytes(secret);
  signers.set(secret, created);
  return created;
}

/** The stand-in custody keypair, built once per process. */
export function testSigner(): Promise<KeyPairSigner> {
  return signerFor(TEST_SIGNER_SECRET);
}

/**
 * A `signMessage` that behaves like custody: raw Ed25519 over the exact bytes,
 * base64 in and out, refusing an owner it does not hold — the same refusal a
 * real provider gives when custody does not control the address.
 */
export const testSignMessage: SignMessage = async (messageBase64, owner) => {
  const candidates = await Promise.all(
    [TEST_SIGNER_SECRET, TEST_OTHER_SIGNER_SECRET].map(signerFor)
  );
  const signer = candidates.find((candidate) => candidate.address === owner);
  if (!signer) {
    throw new Error(`the test signer does not hold ${owner}`);
  }

  const message = new Uint8Array(getBase64Codec().encode(messageBase64));
  return getBase64Codec().decode(await signBytes(signer.keyPair.privateKey, message));
};

/** A custody-rooted source over the test keypair. */
export function testMaterialSource(): ShieldedMaterialSource {
  return createCustodyMaterialSource({ signMessage: testSignMessage });
}

/** The raw seed, for suites asserting that no secret reaches an output. */
export function testDerivationSeed(owner: string = TEST_OWNER): Promise<Uint8Array> {
  return fetchDerivationSeed(testSignMessage, owner);
}

/**
 * A second identity under the *same* owner, built from explicit key bytes.
 *
 * Derivation cannot produce this any more — one owner derives one identity — but
 * the chain can still publish it, which is exactly what a re-keyed record looks
 * like. Suites that need "this owner, different published keys" build it here.
 */
export async function rekeyedIdentity(owner: string = TEST_OWNER) {
  const material = await createShieldedMaterial({
    viewingKeyBytes: new Uint8Array(32).fill(13),
    nullifierKeyBytes: new Uint8Array(31).fill(17),
    owner,
  });

  try {
    return {
      ...publishedHalves(material.shieldedAddress),
      identity: canonicalShieldedIdentity(material.shieldedAddress),
    };
  } finally {
    material.destroy();
  }
}

/** Derives material, hands it to `use`, and destroys it however `use` ends. */
export function withDerived<T>(
  use: (material: ShieldedMaterial) => T | Promise<T>,
  request: MaterialRequest = TEST_REQUEST
): Promise<T> {
  return testMaterialSource().withMaterial(request, async (material) => use(material));
}

/** The canonical shielded identity the seed derives for a request. */
export function derivedIdentity(request: MaterialRequest = TEST_REQUEST): Promise<string> {
  return withDerived((material) => canonicalShieldedIdentity(material.shieldedAddress), request);
}

/** The published halves of one wallet's identity, as the registry stores them. */
export function publishedKeys(request: MaterialRequest = TEST_REQUEST) {
  return withDerived((material) => publishedHalves(material.shieldedAddress), request);
}

/** A user record the seed genuinely derives, so a match is a real match. */
export async function honestRecord(
  options: { mergingEnabled?: boolean; request?: MaterialRequest } = {}
) {
  const request = options.request ?? TEST_REQUEST;
  return {
    owner: request.owner,
    ...(await publishedKeys(request)),
    mergingEnabled: options.mergingEnabled ?? true,
    bump: 255,
  };
}
