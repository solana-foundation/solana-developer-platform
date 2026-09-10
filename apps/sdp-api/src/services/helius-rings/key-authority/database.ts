import { randomBytes } from "node:crypto";
import { HeliusRingsError, type KeyKind } from "@sdp/helius-rings";
import {
  createShieldedMaterial,
  isValidViewingKeyBytes,
  type MaterialRequest,
  NULLIFIER_KEY_BYTE_LENGTH,
  type ShieldedMaterialSource,
  VIEWING_KEY_BYTE_LENGTH,
} from "@sdp/helius-rings-sdk";
import type {
  HeliusRingsKeyRefRepository,
  HeliusRingsKeyRefRow,
} from "@/db/repositories/helius-rings-key-ref.repository";
import type { CustodyCipher } from "@/services/custody-cipher/cipher-router";

/**
 * A viewing candidate is occasionally out of range for a P-256 scalar. Random
 * draws are independent, so this bound is about not looping forever on a broken
 * RNG rather than about exhausting a search.
 */
const MAX_VIEWING_KEY_ATTEMPTS = 8;

/** Everything needed to read or write one org's sealed material. */
interface KeyStore {
  readonly keyRefs: HeliusRingsKeyRefRepository;
  readonly cipher: CustodyCipher;
  /** Scopes the cipher's derived key, so one org's blob cannot open under another. */
  readonly organizationId: string;
}

/**
 * Recorded on each row so a later rotation can find what sealed it without
 * guessing. Mirrors the custody store's encryption_version derivation, which
 * reads the same `v2.` prefix the cipher router dispatches on.
 */
function keyVersionOf(ciphertext: string): string {
  return ciphertext.startsWith("v2.") ? "sdp-rings-key-kms-v2" : "sdp-rings-key-encryption-v1";
}

/**
 * Generates a viewing secret. Unlike the deterministic authority this cannot
 * walk a counter — there is no path to walk — so it redraws.
 */
function generateKeyBytes(kind: KeyKind): Uint8Array {
  if (kind === "nullifier") {
    return new Uint8Array(randomBytes(NULLIFIER_KEY_BYTE_LENGTH));
  }

  for (let attempt = 0; attempt < MAX_VIEWING_KEY_ATTEMPTS; attempt += 1) {
    const candidate = new Uint8Array(randomBytes(VIEWING_KEY_BYTE_LENGTH));
    if (isValidViewingKeyBytes(candidate)) {
      return candidate;
    }
  }

  throw new HeliusRingsError(
    "config_error",
    `could not generate a Rings viewing key in ${MAX_VIEWING_KEY_ATTEMPTS} attempts`
  );
}

async function open(store: KeyStore, row: HeliusRingsKeyRefRow): Promise<Uint8Array> {
  const plaintext = await store.cipher.decrypt(store.organizationId, row.ciphertext);
  return new Uint8Array(Buffer.from(plaintext, "base64"));
}

async function readSealed(
  store: KeyStore,
  walletId: string,
  kind: KeyKind
): Promise<Uint8Array | null> {
  const row = await store.keyRefs.getKeyRef({ walletId, kind });
  return row ? await open(store, row) : null;
}

/**
 * Generates and seals one key, returning whatever is stored afterwards, which is
 * not necessarily what was just generated: a concurrent writer may have sealed
 * first, and `createKeyRef` preserves that blob. Reading the returned row rather
 * than trusting the local bytes is what stops the two kinds from coming from
 * different writers, which would build an identity neither of them published.
 */
async function seal(store: KeyStore, walletId: string, kind: KeyKind): Promise<Uint8Array> {
  const ciphertext = await store.cipher.encrypt(
    store.organizationId,
    Buffer.from(generateKeyBytes(kind)).toString("base64")
  );
  const row = await store.keyRefs.createKeyRef({
    walletId,
    kind,
    ciphertext,
    keyVersion: keyVersionOf(ciphertext),
    materialTag: "live",
  });
  if (!row) {
    throw new HeliusRingsError(
      "config_error",
      `sealing the Rings ${kind} key for this wallet returned no row`
    );
  }
  return await open(store, row);
}

export interface DbMaterialSourceConfig extends KeyStore {
  /**
   * Whether this particular call may seal new material. The router decides it
   * from the wallet's own state, because only a wallet that has not published an
   * identity yet is legitimately asking for keys it does not have.
   */
  readonly mayCreate: boolean;
}

/**
 * A {@link ShieldedMaterialSource} that keeps each wallet's keys sealed in
 * Postgres, generated once and read back on every later use.
 *
 * The wallet's identity is derived from these exact bytes, so what this reads is
 * not a cache — losing it loses the wallet. That is why sealing is write-once
 * (see `createKeyRef`) and why nothing on this path ever re-seals.
 */
export function createDbMaterialSource(config: DbMaterialSourceConfig): ShieldedMaterialSource {
  const { mayCreate, ...store } = config;

  async function loadKey(walletId: string, kind: KeyKind): Promise<Uint8Array> {
    const existing = await readSealed(store, walletId, kind);
    if (existing) return existing;

    if (!mayCreate) {
      // Reached when something asks for the keys of a wallet that already
      // published an identity but has no stored material — one whose keys were
      // lost, or one provisioned under a different authority. Generating here
      // would seal a keypair that cannot derive the published identity, and
      // because sealing is write-once that would be permanent.
      throw new HeliusRingsError(
        "config_error",
        "this Rings wallet has no stored key material and is past provisioning, so new keys cannot be sealed for it"
      );
    }

    return await seal(store, walletId, kind);
  }

  return {
    async withMaterial(request: MaterialRequest, use) {
      // Sequential rather than concurrent: the viewing key is the one that can
      // fail to generate, and on a cold provision there is no reason to seal a
      // nullifier key for a wallet whose viewing key never materialized.
      const viewingKeyBytes = await loadKey(request.walletId, "viewing");
      const nullifierKeyBytes = await loadKey(request.walletId, "nullifier");

      const material = await createShieldedMaterial({
        viewingKeyBytes,
        nullifierKeyBytes,
        owner: request.owner,
      });

      try {
        return await use(material);
      } finally {
        material.destroy();
      }
    },
  };
}

export interface RotateDbMaterialInput extends KeyStore {
  readonly walletId: string;
}

/**
 * Replaces a wallet's sealed material with freshly generated keys.
 *
 * Rotation cannot go through `withMaterial`: sealing is write-once, so a re-key
 * that merely asked for material would read the old blobs back and republish the
 * identity it was trying to abandon — succeeding while rotating nothing. Clearing
 * first is what makes the next read cold.
 *
 * Whatever the old keys held becomes unspendable. The caller is expected to have
 * established that already, which is why this is unreachable from the material
 * source and has exactly one caller.
 */
export async function rotateDbMaterial(input: RotateDbMaterialInput): Promise<void> {
  const { walletId, ...store } = input;
  await store.keyRefs.deleteKeyRefsByWallet({ walletId });
  await seal(store, walletId, "viewing");
  await seal(store, walletId, "nullifier");
}
