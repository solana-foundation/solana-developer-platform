import { hkdfSync } from "node:crypto";
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

/**
 * Domain separator for every key this module derives. Changing it re-keys every
 * identity, which on a registered wallet is an identity conflict rather than a
 * rotation, so it is versioned instead of edited.
 */
const HKDF_SALT = "sdp/helius-rings/fake-ka/v1";

const SEED_LENGTH = 32;
const VIEWING_KEY_LENGTH = 32;

/**
 * A viewing secret is a P-256 scalar, so a uniformly random 32 bytes is
 * occasionally out of range. Walk a counter rather than mangling the bytes: the
 * accepted counter is part of the derivation and stays reproducible.
 */
const MAX_VIEWING_KEY_ATTEMPTS = 8;

/** A nullifier secret is 31 bytes, always inside the BN254 field. */
const NULLIFIER_KEY_LENGTH = 31;

export interface ShieldedMaterialInput {
  /** 32 raw bytes. The caller is responsible for keeping this out of logs. */
  readonly seed: Uint8Array;
  /**
   * Opaque derivation scope. Two different scopes yield unlinkable identities;
   * the same scope always yields the same one.
   */
  readonly scope: string;
  /**
   * Base58 Solana address that owns the identity on chain and signs its spends.
   * Kept as a plain string so this surface does not leak a `@solana/kit` major
   * into callers that are still on the workspace's Kit 6.
   */
  readonly owner: string;
}

/**
 * Rings key material for one identity, plus the public address that publishes
 * it. Both keys hold secrets, so callers must `destroy()` in a `finally`.
 */
export interface ShieldedMaterial {
  readonly viewingKey: ViewingKey;
  readonly nullifierKey: NullifierKey;
  readonly shieldedAddress: ShieldedAddress;
  destroy(): void;
}

function derive(seed: Uint8Array, info: string, length: number): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", seed, HKDF_SALT, info, length));
}

function deriveViewingKey(seed: Uint8Array, scope: string): ViewingKey {
  for (let counter = 0; counter < MAX_VIEWING_KEY_ATTEMPTS; counter += 1) {
    const candidate = derive(seed, `viewing/${scope}/${counter}`, VIEWING_KEY_LENGTH);
    try {
      return ViewingKey.fromBytes(candidate as Bytes32);
    } catch {
      // Out-of-range scalar; the next counter is a fresh uniform candidate.
    }
  }

  throw new Error(
    `Could not derive a viewing key for scope ${scope} in ${MAX_VIEWING_KEY_ATTEMPTS} attempts.`
  );
}

function deriveNullifierKey(seed: Uint8Array, scope: string): NullifierKey {
  return NullifierKey.fromSecret(
    derive(seed, `nullifier/${scope}`, NULLIFIER_KEY_LENGTH) as Bytes31
  );
}

/**
 * Derives the viewing and nullifier keys for one identity and binds them to an
 * owner whose Ed25519 secret this process never sees.
 *
 * That separation is the point: the owner signs the outer Solana transaction
 * through SDP custody, while the shielded keys are derived here. The SDK's own
 * `ShieldedKeypair` expands both role keys from the signing secret, which a
 * custodian will not release, so the keys are derived independently and
 * published together through `ShieldedAddress.fromPublicKeys`.
 */
export async function deriveShieldedMaterial(
  input: ShieldedMaterialInput
): Promise<ShieldedMaterial> {
  if (input.seed.length !== SEED_LENGTH) {
    throw new Error(`Rings derivation seed must be ${SEED_LENGTH} bytes.`);
  }
  if (input.scope.length === 0) {
    throw new Error("Rings derivation scope must not be empty.");
  }

  // The owner hash and the nullifier public key are Poseidon hashes, so the
  // hasher has to be resident before an address can be formed. Loading is
  // cached, so paying for it here keeps every caller from having to remember.
  await initializePoseidon();

  const viewingKey = deriveViewingKey(input.seed, input.scope);
  let nullifierKey: NullifierKey;
  try {
    nullifierKey = deriveNullifierKey(input.seed, input.scope);
  } catch (error) {
    viewingKey.destroy();
    throw error;
  }

  const ownerBytes = new Uint8Array(getAddressEncoder().encode(address(input.owner))) as Bytes32;
  const shieldedAddress = ShieldedAddress.fromPublicKeys(
    ShieldedPublicKey.fromEd25519(ownerBytes),
    nullifierKey.publicKey(),
    viewingKey.publicKey()
  );

  return {
    viewingKey,
    nullifierKey,
    shieldedAddress,
    destroy() {
      viewingKey.destroy();
      nullifierKey.destroy();
    },
  };
}

/**
 * The canonical string form of a shielded identity: base58 of the 65-byte
 * compressed address. Persist this and re-derive it on every use so a seed or
 * scope change fails closed instead of silently addressing a new identity.
 */
export function canonicalShieldedIdentity(address: ShieldedAddress): string {
  return getBase58Decoder().decode(CompressedShieldedAddress.fromAddress(address).bytes);
}
