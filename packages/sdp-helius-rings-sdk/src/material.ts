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
import { address, getAddressEncoder, getBase58Decoder } from "@solana/kit";

/** A viewing secret is a P-256 scalar, so not every 32 bytes are in range. */
export const VIEWING_KEY_BYTE_LENGTH = 32;

/** A nullifier secret is 31 bytes, which is always inside the BN254 field. */
export const NULLIFIER_KEY_BYTE_LENGTH = 31;

/**
 * Identifies the wallet a {@link ShieldedMaterialSource} should produce material
 * for. The tenant triple is how SDP addresses a wallet; how a source turns that
 * into key material is the source's own business.
 */
export interface MaterialRequest {
  readonly organizationId: string;
  readonly projectId: string;
  readonly walletId: string;
  /**
   * Base58 Solana address that owns the identity on chain and signs its spends.
   * Kept as a plain string so this surface does not leak a `@solana/kit` major
   * into callers that are still on the workspace's Kit 6.
   */
  readonly owner: string;
}

/**
 * Rings key material for one identity, plus the public address that publishes
 * it. Both keys hold secrets, so prefer receiving this through
 * {@link ShieldedMaterialSource.withMaterial} over holding one yourself.
 */
export interface ShieldedMaterial {
  readonly viewingKey: ViewingKey;
  readonly nullifierKey: NullifierKey;
  readonly shieldedAddress: ShieldedAddress;
  destroy(): void;
}

/**
 * Where shielded key material comes from.
 *
 * Every source has to put both secrets in this process, and that is a property
 * of the SDK rather than a shortcut: `WalletAuthority` returns concrete
 * `ViewingKey` and `NullifierKey` instances, and `ViewingKeyLike` documents that
 * a backend answering viewing-key operations over a wire is unsupported. So a
 * different key authority is a different *source* of material, not a remote
 * holder of it, and this interface is the whole seam between the two.
 */
export interface ShieldedMaterialSource {
  /**
   * Produces material for one wallet, hands it to `use`, and destroys it
   * however `use` ends. A scope rather than a getter so no implementation can
   * hand out live secrets with nobody responsible for reclaiming them.
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
  /** Base58 Solana address that owns the identity and signs its spends. */
  readonly owner: string;
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

/**
 * Whether 32 bytes are in range for a viewing secret.
 *
 * Exposed so a source can choose its next candidate without having to guess
 * which SDK error means "out of range"; the key it builds to answer is
 * destroyed before returning.
 */
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
 * Builds one identity from raw key bytes and the owner that publishes it.
 *
 * This is the part every source shares, and it never involves the owner's
 * Ed25519 secret: ownership enters the proof as a hash of the public key, and
 * authorization is the owner's signature on the outer Solana transaction. The
 * SDK has no constructor for this shape because each of its own expands both
 * role keys from a signing secret, so the three public halves are published
 * together through `ShieldedAddress.fromPublicKeys` instead.
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

  // The owner hash and the nullifier public key are Poseidon hashes, so the
  // hasher has to be resident before an address can be formed. Loading is
  // cached, so paying for it here keeps every caller from having to remember.
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

    return {
      viewingKey,
      nullifierKey: resolvedNullifierKey,
      shieldedAddress,
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
 * The canonical string form of a shielded identity: base58 of the 65-byte
 * compressed address. Persist this and re-derive it on every use so a change in
 * the source's inputs fails closed instead of addressing a new identity.
 */
export function canonicalShieldedIdentity(shieldedAddress: ShieldedAddress): string {
  return getBase58Decoder().decode(CompressedShieldedAddress.fromAddress(shieldedAddress).bytes);
}

/**
 * Refuses to proceed when material does not reproduce the identity that was
 * persisted. A registered wallet's nullifier key cannot be replaced, so a
 * mismatch is never a rotation to accept — it means the source's inputs moved,
 * and continuing would address a different identity.
 */
export function assertShieldedIdentity(material: ShieldedMaterial, expected: string): void {
  const derived = canonicalShieldedIdentity(material.shieldedAddress);

  if (derived !== expected) {
    throw new RingsIdentityMismatchError(expected, derived);
  }
}
