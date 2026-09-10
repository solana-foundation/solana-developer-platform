import {
  type Bytes31,
  type Bytes32,
  CompressedShieldedAddress,
  initializePoseidon,
  NullifierKey,
  ShieldedAddress,
  ShieldedPublicKey,
  ViewingKey,
} from "@heliuslabs/zolana";
import { LocalKeys, type ProofService } from "@heliuslabs/zolana/client";
import { LocalShieldedKeys } from "@heliuslabs/zolana/transaction";
import { HeliusRingsError, RINGS_IDENTITY_MISMATCH, type RingsErrorCause } from "@sdp/helius-rings";
import { address, getAddressEncoder, getBase58Decoder } from "@solana/kit";

/** A viewing secret is a P-256 scalar, so not every 32 bytes are in range. */
export const VIEWING_KEY_BYTE_LENGTH = 32;

/** A nullifier secret is 31 bytes, which is always inside the BN254 field. */
export const NULLIFIER_KEY_BYTE_LENGTH = 31;

/** The wallet a {@link ShieldedMaterialSource} should produce material for. */
export interface MaterialRequest {
  readonly organizationId: string;
  readonly projectId: string;
  readonly walletId: string;
  /**
   * Base58 address that owns the identity on chain. A plain string so this
   * surface does not leak a `@solana/kit` major into callers still on Kit 6.
   */
  readonly owner: string;
}

/**
 * Rings key material for one identity.
 *
 * The secrets stay inside: a caller gets the address, the two published halves,
 * and freshly-built key objects it owns and destroys. Zolana 0.1.6 exposes no
 * public way back from a derivation seed to a bare `ViewingKey`/`NullifierKey`
 * pair, so handing those out would rule out the seed-rooted source entirely.
 * Both factories copy, so each result has its own lifetime.
 */
export interface ShieldedMaterial {
  readonly shieldedAddress: ShieldedAddress;
  /** Read only: derivation and decryption, no proving. */
  readKeys(): LocalShieldedKeys;
  /** Read and spend. `prove` completes the witness with the nullifier secret. */
  spendKeys(proofs: ProofService): LocalKeys;
  destroy(): void;
}

/** The published halves of an identity, as the on-chain registry stores them. */
export function publishedHalves(shieldedAddress: ShieldedAddress): {
  nullifierPublicKey: Bytes32;
  viewingPublicKey: Uint8Array;
} {
  return {
    nullifierPublicKey: shieldedAddress.nullifierPublicKey,
    viewingPublicKey: shieldedAddress.viewingPublicKey.toBytes(),
  };
}

/**
 * Where shielded key material comes from. Every source has to hold both secrets
 * in this process, so a different key authority is a different source rather
 * than a remote holder of one.
 */
export interface ShieldedMaterialSource {
  /**
   * Produces material for one wallet, hands it to `use`, and destroys it however
   * `use` ends, so no implementation can hand out unreclaimed live secrets.
   */
  withMaterial<T>(
    request: MaterialRequest,
    use: (material: ShieldedMaterial) => Promise<T>
  ): Promise<T>;
}

export interface ShieldedMaterialInput {
  /** 32 bytes that form a valid P-256 scalar. */
  readonly viewingKeyBytes: Uint8Array;
  /** 31 bytes. */
  readonly nullifierKeyBytes: Uint8Array;
  /** Base58 Solana address that owns the identity. */
  readonly owner: string;
}

export interface DerivationSeedMaterialInput {
  /** Base58 Solana address that owns the identity. */
  readonly owner: string;
  /** The owner's 64-byte Ed25519 signature over `ed25519DerivationMessage(owner)`. */
  readonly derivationSeed: Uint8Array;
}

/** Raised when a re-derived identity does not match the persisted one. */
export class RingsIdentityMismatchError extends Error {
  readonly expected: string;
  readonly derived: string;

  constructor(expected: string, derived: string) {
    super(`Rings identity ${derived} does not match the persisted ${expected}.`);
    // biome-ignore lint/security/noSecrets: error class name, not a secret.
    this.name = "RingsIdentityMismatchError";
    this.expected = expected;
    this.derived = derived;
  }
}

/** Whether 32 bytes are in range for a viewing secret, so a source can pick another candidate. */
export function isValidViewingKeyBytes(bytes: Uint8Array): boolean {
  if (bytes.length !== VIEWING_KEY_BYTE_LENGTH) {
    return false;
  }

  try {
    ViewingKey.fromBytes(bytes as Bytes32).destroy();
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds one identity from raw key bytes and the owner that publishes it. The
 * owner's Ed25519 secret is never involved: ownership enters as a hash of the
 * public key, and authorization is its signature on the outer transaction.
 */
export async function createShieldedMaterial(
  input: ShieldedMaterialInput
): Promise<ShieldedMaterial> {
  if (input.viewingKeyBytes.length !== VIEWING_KEY_BYTE_LENGTH) {
    throw new Error(`A Rings viewing key must be ${VIEWING_KEY_BYTE_LENGTH} bytes.`);
  }
  if (input.nullifierKeyBytes.length !== NULLIFIER_KEY_BYTE_LENGTH) {
    throw new Error(`A Rings nullifier key must be ${NULLIFIER_KEY_BYTE_LENGTH} bytes.`);
  }

  // Poseidon has to be resident before an address can be formed; loading is cached.
  await initializePoseidon();

  const viewingKey = ViewingKey.fromBytes(input.viewingKeyBytes as Bytes32);
  let nullifierKey: NullifierKey | undefined;

  try {
    nullifierKey = NullifierKey.fromSecret(input.nullifierKeyBytes as Bytes31);

    const ownerBytes = new Uint8Array(getAddressEncoder().encode(address(input.owner))) as Bytes32;
    const shieldedAddress = ShieldedAddress.fromPublicKeys(
      ShieldedPublicKey.fromEd25519(ownerBytes),
      nullifierKey.publicKey(),
      viewingKey.publicKey()
    );
    const resolvedNullifierKey = nullifierKey;
    // `fromKeys` copies, so the trio these two build from is ours to destroy and
    // every result owns its own lifetime.
    const trio = {
      address: shieldedAddress,
      viewingKeys: [viewingKey],
      nullifierKey: resolvedNullifierKey,
    };

    return {
      shieldedAddress,
      readKeys: () => LocalShieldedKeys.fromKeys(trio),
      spendKeys: (proofs) => LocalKeys.fromKeys(trio, proofs),
      destroy() {
        viewingKey.destroy();
        resolvedNullifierKey.destroy();
      },
    };
  } catch (error) {
    nullifierKey?.destroy();
    viewingKey.destroy();
    throw error;
  }
}

/**
 * Builds one identity from the owner's derivation seed: its Ed25519 signature
 * over `ed25519DerivationMessage(owner)`.
 *
 * The seed never becomes a bare key pair here. Zolana verifies the signature
 * against `owner` on every call and expands it internally, so a seed that is the
 * right width but not that signature fails before it derives anything. Both
 * factories re-expand rather than share, which costs one HKDF and keeps each
 * result independently destroyable.
 *
 * The caller keeps ownership of `derivationSeed`; the SDK copies it and clears
 * only its own copy.
 */
export async function createShieldedMaterialFromDerivationSeed(
  input: DerivationSeedMaterialInput
): Promise<ShieldedMaterial> {
  // Poseidon has to be resident before an address can be formed; loading is cached.
  await initializePoseidon();

  const solanaPublicKey = address(input.owner);
  const seed = input.derivationSeed;
  const seedInput = { solanaPublicKey, derivationSeed: seed };

  // Built once so a bad seed fails here rather than on first use, and so the
  // address is available without a factory call.
  const probe = LocalShieldedKeys.fromDerivationSeed(seedInput);
  let shieldedAddress: ShieldedAddress;
  try {
    shieldedAddress = probe.address();
  } finally {
    probe.destroy();
  }

  return {
    shieldedAddress,
    readKeys: () => LocalShieldedKeys.fromDerivationSeed(seedInput),
    spendKeys: (proofs) => LocalKeys.fromDerivationSeed(seedInput, proofs),
    // The seed belongs to the source that fetched it; it clears its own copy.
    destroy() {},
  };
}

/**
 * Base58 of the compressed shielded address. Persist this and re-derive it on
 * every use so a change in the source's inputs fails closed.
 */
export function canonicalShieldedIdentity(shieldedAddress: ShieldedAddress): string {
  return getBase58Decoder().decode(CompressedShieldedAddress.fromAddress(shieldedAddress).bytes);
}

/**
 * Refuses to proceed when material does not reproduce the persisted identity.
 * The registry's `update_keys` would let the owner re-key its record, but taking
 * that would orphan every note encrypted to the old keys.
 */
export function assertShieldedIdentity(material: ShieldedMaterial, expected: string): void {
  const derived = canonicalShieldedIdentity(material.shieldedAddress);

  if (derived !== expected) {
    throw new RingsIdentityMismatchError(expected, derived);
  }
}

/**
 * Fixed message: the raw error's two shielded addresses tell an operator nothing
 * they can act on, so this names the inputs that moved instead.
 */
const IDENTITY_MISMATCH_MESSAGE =
  "the Rings identity derived for this wallet is not the one it was provisioned with; check the wallet's owner and the organization and project it was provisioned under";

/**
 * Fails closed on a mismatch as a domain failure; untranslated it reaches the
 * operator as an opaque 500. `conflict`, because the next read derives the same
 * identity from the same inputs and a retry cannot succeed.
 */
export function assertProvisionedIdentity(material: ShieldedMaterial, expected: string): void {
  try {
    assertShieldedIdentity(material, expected);
  } catch (error) {
    if (!(error instanceof RingsIdentityMismatchError)) throw error;
    // Named on the cause so the service can quarantine on this one conflict
    // without reading the message. The two addresses stay out of it.
    throw new HeliusRingsError("conflict", IDENTITY_MISMATCH_MESSAGE, {
      cause: { upstream: RINGS_IDENTITY_MISMATCH } satisfies RingsErrorCause,
    });
  }
}
