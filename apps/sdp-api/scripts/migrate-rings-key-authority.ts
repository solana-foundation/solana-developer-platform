// ONE-SHOT MIGRATION.
//
// TODO(rings-key-migration): once every deployment reports skipped=0, failed=0,
// and remaining=0, delete this file, its test, the `rings:keys:migrate` package
// entry, and their two explicit tsconfig includes. Nothing under src/ imports the
// script, which is also why it reaches for repositories and the cipher directly
// instead of adding permanent service surface for a single run.
//
// Moves Helius Rings wallets off the seed-derived key authority onto stored keys.
//
// Lossless and identity-preserving. The seed authority derives from the shipped
// seed plus each wallet's org/project/id, so this recomputes the exact bytes each
// wallet's identity was built from, verifies they reproduce the published shielded
// address, seals them, and only then re-pins the wallet. No on-chain transaction,
// no re-key, nothing abandoned. A re-key would also leave a working wallet, but it
// would discard everything the old keys hold — that difference is why this
// verifies before it writes.
//
// Safe to rerun: sealing is write-once and the re-pin is a compare-and-swap.
// Migrated rows leave the scan, so a completed rerun reports remaining=0. Rerun
// until skipped, failed, and remaining all reach zero.
//
// Run only after Rings writes are stopped, active provisioning/re-key requests
// have drained, and the new deployment has fully replaced old replicas. A
// provisioner that already loaded deterministic material can otherwise publish it
// after this script re-pins the pending row.
//
// Reads DATABASE_URL and the configured Rings cipher from the environment;
// nothing here loads a .env file. Locally, export them first:
//
//   cd apps/sdp-api && set -a && . ./.env.local && set +a
//   pnpm rings:keys:migrate --dry-run
//   pnpm rings:keys:migrate

import { fileURLToPath } from "node:url";
import {
  canonicalShieldedIdentity,
  createShieldedMaterial,
  DETERMINISTIC_KA_SEED,
  type DerivedKeyBytes,
  deriveKeyBytes,
} from "@sdp/helius-rings-sdk";
import { closeDatabasePools, getDb, runWithSystemDatabaseIdentity } from "../src/db";
import {
  createHeliusRingsKeyRefRepository,
  type HeliusRingsKeyRefRepository,
  type HeliusRingsWalletRow,
} from "../src/db/repositories";
import { createRingsKeyCipher } from "../src/lib/rings-key-crypto";
import { getProcessEnv } from "../src/lib/runtime-env";
import type { CustodyCipher } from "../src/services/custody-cipher/cipher-router";
import type { Env } from "../src/types/env";

const BATCH_SIZE = 100;

export type MigrationOutcome =
  /** Already on stored keys; a rerun sees this for everything it converted. */
  | { readonly kind: "already-migrated" }
  /**
   * Never provisioned, so there is no identity to preserve and nothing worth
   * importing. Re-pinned without sealing, which is strictly better: it will
   * generate random keys when it provisions instead of inheriting public ones.
   */
  | { readonly kind: "repinned-unprovisioned" }
  | { readonly kind: "migrated"; readonly shieldedAddress: string }
  | { readonly kind: "skipped"; readonly reason: string };

export interface MigrateWalletDeps {
  readonly keyRefs: HeliusRingsKeyRefRepository;
  readonly cipher: CustodyCipher;
  /** Compare-and-swap from `deterministic` to `database`; false when it loses. */
  readonly repin: (wallet: HeliusRingsWalletRow) => Promise<boolean>;
  /**
   * Run every check but no write, returning the outcome the real run would reach.
   * A preview that skipped the checks would report wallets as migratable that the
   * real run refuses, which is worse than no preview.
   */
  readonly dryRun?: boolean;
  /** Overridable so tests do not depend on the shipped seed's value. */
  readonly seed?: Uint8Array;
}

/** Mirrors the private helper in services/helius-rings/key-authority/database.ts. */
function keyVersionOf(ciphertext: string): string {
  return ciphertext.startsWith("v2.") ? "sdp-rings-key-kms-v2" : "sdp-rings-key-encryption-v1";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Seals one key and returns what is stored afterwards, which is not necessarily
 * what was passed in: `createKeyRef` preserves an existing blob rather than
 * overwriting it. Reading the result back is what lets the caller confirm the
 * wallet ended up with the bytes it verified.
 */
async function sealKey(
  deps: MigrateWalletDeps,
  wallet: HeliusRingsWalletRow,
  kind: "viewing" | "nullifier",
  bytes: Uint8Array
): Promise<Uint8Array> {
  const organizationId = wallet.organization_id;
  const encoded = Buffer.from(bytes);
  let ciphertext: string;
  try {
    ciphertext = await deps.cipher.encrypt(organizationId, encoded.toString("base64"));
  } finally {
    encoded.fill(0);
  }
  const row = await deps.keyRefs.createKeyRef({
    walletId: wallet.id,
    kind,
    ciphertext,
    keyVersion: keyVersionOf(ciphertext),
    materialTag: "live",
  });
  if (!row) throw new Error(`sealing the ${kind} key returned no row`);
  const decoded = Buffer.from(await deps.cipher.decrypt(organizationId, row.ciphertext), "base64");
  try {
    return Uint8Array.from(decoded);
  } finally {
    decoded.fill(0);
  }
}

/**
 * What sealing will find, before writing anything.
 *
 * Shared by preview and real mode: `createKeyRef` preserves a blob already there,
 * so validating both kinds first prevents the real run from writing a missing
 * kind and only then discovering that its partner makes the wallet unmigratable.
 */
async function validateExistingMaterial(
  deps: MigrateWalletDeps,
  wallet: HeliusRingsWalletRow,
  derived: DerivedKeyBytes
): Promise<Extract<MigrationOutcome, { kind: "skipped" }> | null> {
  const kinds = [
    ["viewing", derived.viewingKeyBytes],
    ["nullifier", derived.nullifierKeyBytes],
  ] as const;

  for (const [kind, expected] of kinds) {
    const row = await deps.keyRefs.getKeyRef({ walletId: wallet.id, kind });
    if (!row) continue;
    const decoded = Buffer.from(
      await deps.cipher.decrypt(wallet.organization_id, row.ciphertext),
      "base64"
    );
    const stored = Uint8Array.from(decoded);
    decoded.fill(0);
    try {
      if (!sameBytes(stored, expected)) {
        return {
          kind: "skipped",
          reason: `an existing ${kind} key does not match the verified derivation; left pinned unchanged`,
        };
      }
    } finally {
      stored.fill(0);
    }
  }

  return null;
}

const CIPHER_PREFLIGHT_ORG = "rings-key-migration-preflight";
const CIPHER_PREFLIGHT_PLAINTEXT = Buffer.from(
  "sdp-rings-key-migration-cipher-preflight",
  "utf8"
).toString("base64");

/** Proves the selected environment/KMS cipher can open what it writes before any row changes. */
export async function verifyMigrationCipher(cipher: CustodyCipher): Promise<void> {
  const ciphertext = await cipher.encrypt(CIPHER_PREFLIGHT_ORG, CIPHER_PREFLIGHT_PLAINTEXT);
  const opened = await cipher.decrypt(CIPHER_PREFLIGHT_ORG, ciphertext);
  if (opened !== CIPHER_PREFLIGHT_PLAINTEXT) {
    throw new Error("Rings key cipher preflight failed its round-trip");
  }
}

export async function migrateWallet(
  wallet: HeliusRingsWalletRow,
  deps: MigrateWalletDeps
): Promise<MigrationOutcome> {
  const seed = deps.seed ?? DETERMINISTIC_KA_SEED;

  if (wallet.key_authority === "database") return { kind: "already-migrated" };
  if (wallet.key_authority !== "deterministic") {
    return { kind: "skipped", reason: `unsupported source authority ${wallet.key_authority}` };
  }

  if (wallet.shielded_address === null) {
    if (deps.dryRun) return { kind: "repinned-unprovisioned" };
    return (await deps.repin(wallet))
      ? { kind: "repinned-unprovisioned" }
      : { kind: "skipped", reason: "the wallet changed authority concurrently" };
  }

  // Provisioned wallets are pinned to an owner as well as an address, because the
  // identity is derived from both. Without the owner the derivation cannot be
  // checked, and sealing unverified bytes is exactly the mistake that would make
  // the wallet unspendable.
  if (wallet.owner_address === null) {
    return {
      kind: "skipped",
      reason: "the wallet has a shielded address but no owner, so its identity cannot be verified",
    };
  }

  const derived = deriveKeyBytes(seed, {
    organizationId: wallet.organization_id,
    projectId: wallet.project_id,
    walletId: wallet.id,
    owner: wallet.owner_address,
  });

  try {
    const candidate = await createShieldedMaterial({ ...derived, owner: wallet.owner_address });
    let derivedIdentity: string;
    try {
      derivedIdentity = canonicalShieldedIdentity(candidate.shieldedAddress);
    } finally {
      candidate.destroy();
    }

    // Refuse anything the seed does not reproduce. Such a wallet is already
    // broken, and importing mismatched keys would make it permanent because
    // createKeyRef never overwrites.
    if (derivedIdentity !== wallet.shielded_address) {
      return {
        kind: "skipped",
        reason: `the seed derives ${derivedIdentity}, not the published ${wallet.shielded_address}`,
      };
    }

    const existingMismatch = await validateExistingMaterial(deps, wallet, derived);
    if (existingMismatch) return existingMismatch;

    if (deps.dryRun) return { kind: "migrated", shieldedAddress: wallet.shielded_address };

    const storedViewing = await sealKey(deps, wallet, "viewing", derived.viewingKeyBytes);
    try {
      const storedNullifier = await sealKey(deps, wallet, "nullifier", derived.nullifierKeyBytes);
      try {
        // What came back is what the database authority will read on the next
        // use. If it differs, another writer sealed first and re-pinning would
        // hand the wallet keys deriving a different identity.
        if (
          !sameBytes(storedViewing, derived.viewingKeyBytes) ||
          !sameBytes(storedNullifier, derived.nullifierKeyBytes)
        ) {
          return {
            kind: "skipped",
            reason:
              "stored key material does not match the verified derivation; left pinned unchanged",
          };
        }
      } finally {
        storedNullifier.fill(0);
      }
    } finally {
      storedViewing.fill(0);
    }

    return (await deps.repin(wallet))
      ? { kind: "migrated", shieldedAddress: wallet.shielded_address }
      : { kind: "skipped", reason: "the wallet changed authority concurrently" };
  } finally {
    derived.viewingKeyBytes.fill(0);
    derived.nullifierKeyBytes.fill(0);
  }
}

interface Counters {
  migrated: number;
  repinned: number;
  skipped: number;
  failed: number;
}

export function migrationRunFailed(input: {
  dryRun: boolean;
  skipped: number;
  failed: number;
  remaining: number;
}): boolean {
  return input.skipped > 0 || input.failed > 0 || (!input.dryRun && input.remaining > 0);
}

/**
 * Pages by id rather than offset. Rows leave this result set as they are migrated,
 * so an offset would step over the rows that shift down into it.
 */
async function* seedPinnedWallets(env: Env): AsyncGenerator<HeliusRingsWalletRow> {
  const db = getDb(env);
  let lastId = "";

  while (true) {
    const { results } = await db
      .prepare(
        `SELECT * FROM helius_rings_wallets
          WHERE key_authority = 'deterministic'
            AND id > ?
          ORDER BY id
          LIMIT ${BATCH_SIZE}`
      )
      .bind(lastId)
      .all<HeliusRingsWalletRow>();

    if (results.length === 0) return;
    for (const row of results) {
      lastId = row.id;
      yield row;
    }
  }
}

function record(
  counters: Counters,
  wallet: HeliusRingsWalletRow,
  outcome: MigrationOutcome,
  dryRun: boolean
): void {
  const prefix = dryRun ? "dry-run " : "";
  switch (outcome.kind) {
    case "migrated":
      counters.migrated += 1;
      console.info(`[${prefix}migrated] ${wallet.id} keeps identity ${outcome.shieldedAddress}`);
      return;
    case "repinned-unprovisioned":
      counters.repinned += 1;
      console.info(
        `[${prefix}repinned] ${wallet.id} was never provisioned; it will generate fresh keys`
      );
      return;
    case "already-migrated":
      return;
    case "skipped":
      counters.skipped += 1;
      console.warn(`[${prefix}skipped] ${wallet.id}: ${outcome.reason}`);
      return;
  }
}

async function main(): Promise<void> {
  const env = getProcessEnv();
  const dryRun = process.argv.includes("--dry-run");

  if (!env.RINGS_KEY_ENCRYPTION_KEY) {
    throw new Error(
      "RINGS_KEY_ENCRYPTION_KEY must be set, including alongside KMS so v1 rows remain readable. " +
        "Back up every configured Rings wrapping key before running."
    );
  }

  const db = getDb(env);
  const cipher = createRingsKeyCipher(env);
  await verifyMigrationCipher(cipher);
  const deps: MigrateWalletDeps = {
    keyRefs: createHeliusRingsKeyRefRepository(env),
    cipher,
    dryRun,
    repin: async (wallet) => {
      // Unreachable in a preview, and loud rather than silent if that ever stops
      // being true: a dry run that writes is the one thing it must not do.
      if (dryRun) throw new Error("a dry run must not re-pin a wallet");
      const row = await db
        .prepare(
          `UPDATE helius_rings_wallets
              SET key_authority = 'database', updated_at = sdp_iso_now()
            WHERE id = ?
              AND key_authority = 'deterministic'
          RETURNING id`
        )
        .bind(wallet.id)
        .first<{ id: string }>();
      return row !== null;
    },
  };

  const counters: Counters = {
    migrated: 0,
    repinned: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    // A preview walks the same code, so what it counts is what the real run will
    // do rather than how many candidates the scan found.
    for await (const wallet of seedPinnedWallets(env)) {
      try {
        record(counters, wallet, await migrateWallet(wallet, deps), dryRun);
      } catch (error: unknown) {
        counters.failed += 1;
        console.error(
          `[${dryRun ? "dry-run " : ""}failed] ${wallet.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // The keyset scan is stable for rows it saw, but an old replica could insert
    // a deterministic wallet behind its cursor while this one-shot is running.
    // The final count is the authoritative success condition.
    const remainingRow = await db
      .prepare(
        `SELECT count(*)::text AS count
           FROM helius_rings_wallets
          WHERE key_authority = 'deterministic'`
      )
      .first<{ count: string }>();
    const remaining = Number(remainingRow?.count ?? "0");

    console.info(
      `${dryRun ? "Preview" : "Done"}. migrated=${counters.migrated} ` +
        `repinned=${counters.repinned} skipped=${counters.skipped} ` +
        `failed=${counters.failed} remaining=${remaining}`
    );
    // Skips and failures leave wallets on the public seed, which is the condition
    // this migration exists to end, so they must not read as success.
    if (migrationRunFailed({ dryRun, ...counters, remaining })) {
      console.error(
        dryRun
          ? "Some wallets would not migrate. Resolve the reasons above before running for real."
          : "Some wallets are still on the seed authority. Resolve the reasons and rerun."
      );
      process.exitCode = 1;
    }
  } finally {
    await closeDatabasePools();
  }
}

// Guarded so the test can import `migrateWallet` without opening a pool or
// touching the database.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWithSystemDatabaseIdentity("script:migrate-rings-key-authority", main).catch(
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
