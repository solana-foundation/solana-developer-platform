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
 * Stages freshly generated keys for one kind, keeping the blob they replace in
 * the row's previous slot. Falls back to sealing when the wallet holds no key of
 * that kind, which is a re-key of a wallet that never provisioned.
 */
async function stage(store: KeyStore, walletId: string, kind: KeyKind): Promise<void> {
  const ciphertext = await store.cipher.encrypt(
    store.organizationId,
    Buffer.from(generateKeyBytes(kind)).toString("base64")
  );
  const staged = await store.keyRefs.rotateKeyRef({
    walletId,
    kind,
    ciphertext,
    keyVersion: keyVersionOf(ciphertext),
  });
  if (staged) return;

  if (await store.keyRefs.getKeyRef({ walletId, kind })) {
    // A row exists but would not stage, so its previous slot is already full.
    // Staging over it would discard the only material that still derives the
    // published identity.
    throw new HeliusRingsError(
      "conflict",
      `this Rings wallet already has a rotation staged for its ${kind} key; finish or roll that back first`
    );
  }

  await seal(store, walletId, kind);
}

/**
 * Begins replacing a wallet's sealed material, and returns the two ways the
 * rotation can end.
 *
 * Rotation cannot go through `withMaterial`: sealing is write-once, so a re-key
 * that merely asked for material would read the old blobs back and republish the
 * identity it was trying to abandon — succeeding while rotating nothing. It also
 * has to happen *before* the gateway publishes, because the identity published is
 * derived from the new bytes.
 *
 * That ordering used to make the gateway call unrecoverable: the old keys were
 * deleted, so a failed signature or submission left the wallet advertising an
 * identity nothing could derive. Staging moves the point of no return to the
 * chain write, where it belongs — {@link DbMaterialRotation.rollback} puts the
 * old material back if nothing was published, and
 * {@link DbMaterialRotation.commit} discards it once something was.
 */
export interface DbMaterialRotation {
  /**
   * Accepts the new material and drops the replaced blob. Call this once the new
   * identity is on chain, whether or not the row caught up: from that moment the
   * old material derives an identity the wallet no longer owns, and keeping it is
   * exactly what a re-key after a key compromise must not do.
   */
  commit(): Promise<void>;
  /**
   * Puts the replaced material back, for a rotation that never published. The
   * wallet derives its recorded identity again, so it is stale rather than
   * broken. Idempotent, because the restore only fires on a staged row.
   */
  rollback(): Promise<void>;
}

export async function beginDbMaterialRotation(
  input: RotateDbMaterialInput
): Promise<DbMaterialRotation> {
  const { walletId, ...store } = input;
  const rotation: DbMaterialRotation = {
    async commit() {
      await store.keyRefs.commitKeyRefRotation({ walletId });
    },
    async rollback() {
      await store.keyRefs.restoreKeyRef({ walletId, kind: "viewing" });
      await store.keyRefs.restoreKeyRef({ walletId, kind: "nullifier" });
    },
  };

  await stage(store, walletId, "viewing");
  try {
    await stage(store, walletId, "nullifier");
  } catch (error) {
    // Half a rotation is worse than none: the two kinds would come from
    // different generations and derive an identity nobody published.
    await rotation.rollback();
    throw error;
  }

  return rotation;
}
