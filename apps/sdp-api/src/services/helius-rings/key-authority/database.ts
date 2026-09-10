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
  const decoded = Buffer.from(plaintext, "base64");
  try {
    return Uint8Array.from(decoded);
  } finally {
    decoded.fill(0);
  }
}

/**
 * Generates and seals one key, returning whatever is stored afterwards, which is
 * not necessarily what was just generated: a concurrent writer may have sealed
 * first, and `createKeyRef` preserves that blob. Reading the returned row rather
 * than trusting the local bytes is what stops the two kinds from coming from
 * different writers, which would build an identity neither of them published.
 */
async function seal(store: KeyStore, walletId: string, kind: KeyKind): Promise<void> {
  const generated = generateKeyBytes(kind);
  const encoded = Buffer.from(generated);
  let ciphertext: string;
  try {
    ciphertext = await store.cipher.encrypt(store.organizationId, encoded.toString("base64"));
  } finally {
    generated.fill(0);
    encoded.fill(0);
  }
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

  async function loadPair(walletId: string): Promise<{
    viewingKeyBytes: Uint8Array;
    nullifierKeyBytes: Uint8Array;
  }> {
    let rows = await store.keyRefs.listKeyRefsByWallet({ walletId });
    let viewing = rows.find((row) => row.kind === "viewing");
    let nullifier = rows.find((row) => row.kind === "nullifier");

    if (!(viewing && nullifier)) {
      if (!mayCreate) {
        // Reached when something asks for the keys of a wallet that already
        // published an identity but has no complete stored pair. Generating here
        // would permanently seal material that cannot derive that identity.
        throw new HeliusRingsError(
          "config_error",
          "this Rings wallet has no complete stored key pair and is past provisioning, so new keys cannot be sealed for it"
        );
      }

      // Sequential on a cold provision: do not seal a nullifier key when viewing
      // generation fails. createKeyRef is write-once, so concurrent provisioners
      // converge; the reload below reads the winning pair in one snapshot.
      if (!viewing) await seal(store, walletId, "viewing");
      if (!nullifier) await seal(store, walletId, "nullifier");
      rows = await store.keyRefs.listKeyRefsByWallet({ walletId });
      viewing = rows.find((row) => row.kind === "viewing");
      nullifier = rows.find((row) => row.kind === "nullifier");
    }

    if (!(viewing && nullifier) || rows.length !== 2) {
      throw new HeliusRingsError(
        "config_error",
        "this Rings wallet does not hold exactly one viewing and one nullifier key"
      );
    }

    const viewingKeyBytes = await open(store, viewing);
    try {
      const nullifierKeyBytes = await open(store, nullifier);
      return { viewingKeyBytes, nullifierKeyBytes };
    } catch (error) {
      viewingKeyBytes.fill(0);
      throw error;
    }
  }

  return {
    async withMaterial(request: MaterialRequest, use) {
      const pair = await loadPair(request.walletId);
      let material: Awaited<ReturnType<typeof createShieldedMaterial>> | undefined;
      try {
        material = await createShieldedMaterial({ ...pair, owner: request.owner });
        return await use(material);
      } finally {
        material?.destroy();
        pair.viewingKeyBytes.fill(0);
        pair.nullifierKeyBytes.fill(0);
      }
    },
  };
}

export interface RotateDbMaterialInput extends KeyStore {
  readonly walletId: string;
}

/** Freshly generated material for one kind, sealed but not yet stored. */
async function generateSealed(
  store: KeyStore,
  kind: KeyKind
): Promise<{ ciphertext: string; keyVersion: string }> {
  const generated = generateKeyBytes(kind);
  const encoded = Buffer.from(generated);
  let ciphertext: string;
  try {
    ciphertext = await store.cipher.encrypt(store.organizationId, encoded.toString("base64"));
  } finally {
    generated.fill(0);
    encoded.fill(0);
  }
  return { ciphertext, keyVersion: keyVersionOf(ciphertext) };
}

/**
 * Replaces both kinds in one write, keeping the blobs they replace reachable.
 *
 * Staged together rather than one at a time because a wallet's identity comes
 * from the pair: a process that exited between two writes would leave keys from
 * different generations and derive an identity nobody published. That window
 * cannot be closed in application code, so the repository does it in a single
 * statement.
 */
async function stage(store: KeyStore, walletId: string): Promise<void> {
  const classify = (rows: HeliusRingsKeyRefRow[]): "empty" | "steady" | "staged" | "invalid" => {
    if (rows.length === 0) return "empty";
    if (
      rows.length !== 2 ||
      !rows.some((row) => row.kind === "viewing") ||
      !rows.some((row) => row.kind === "nullifier")
    ) {
      return "invalid";
    }
    const stagedCount = rows.filter((row) => row.previous_ciphertext !== null).length;
    if (stagedCount === 0) return "steady";
    if (stagedCount === 2) return "staged";
    return "invalid";
  };

  const existing = await store.keyRefs.listKeyRefsByWallet({ walletId });
  const state = classify(existing);
  if (state === "staged") {
    // A previous attempt retained this pair because it could not know whether
    // publication happened. Reuse it; another generation would bury the only
    // material that can still match either possible chain state.
    return;
  }
  if (state === "invalid") {
    throw new HeliusRingsError(
      "conflict",
      "this Rings wallet's stored key material cannot be re-keyed: it must hold one viewing and one nullifier key in the same rotation state"
    );
  }
  if (state === "empty") {
    // A re-key of a wallet that never provisioned. A missing kind is completed
    // by the next material read if the process exits between these writes.
    await seal(store, walletId, "viewing");
    await seal(store, walletId, "nullifier");
    return;
  }

  const staged = await store.keyRefs.stageKeyRefRotation({
    walletId,
    viewing: await generateSealed(store, "viewing"),
    nullifier: await generateSealed(store, "nullifier"),
  });
  if (staged === 2) return;

  // Defensive concurrent-writer recovery. The advisory re-key lock makes this
  // unusual, but a second process or an operator can still stage directly.
  const after = classify(await store.keyRefs.listKeyRefsByWallet({ walletId }));
  if (after === "staged") return;
  throw new HeliusRingsError(
    "conflict",
    "this Rings wallet's key pair changed while its rotation was being staged"
  );
}

/**
 * Stages replacement material before the gateway publishes. A rejection leaves
 * it staged because the chain outcome is ambiguous; the next read retries or
 * reconciles the same pair.
 */
export async function beginDbMaterialRotation(input: RotateDbMaterialInput) {
  const { walletId, ...store } = input;
  await stage(store, walletId);

  return {
    async commit() {
      await store.keyRefs.commitKeyRefRotation({ walletId });
    },
  };
}
