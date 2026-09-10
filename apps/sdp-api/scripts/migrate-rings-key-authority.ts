// ONE-SHOT MIGRATION.
//
// TODO(rings-key-migration): delete this file, its test, and the
// `rings:keys:migrate` entry in package.json once every deployment reports
// migrated with skipped=0 and failed=0. Nothing under src/ imports this, so that
// is the whole cleanup — which is also why it reaches for repositories and the
// cipher directly instead of adding permanent service surface for a single run.
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
// Safe to rerun: sealing is write-once and the re-pin is a compare-and-swap, so a
// second run reports everything as already migrated. Rerun until skipped and
// failed both reach zero.
//
// Reads DATABASE_URL and RINGS_KEY_ENCRYPTION_KEY from the environment; nothing
// here loads a .env file. Locally, export them first:
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
  const ciphertext = await deps.cipher.encrypt(
    organizationId,
    Buffer.from(bytes).toString("base64")
  );
  const row = await deps.keyRefs.createKeyRef({
    walletId: wallet.id,
    kind,
    ciphertext,
    keyVersion: keyVersionOf(ciphertext),
    materialTag: "live",
  });
  if (!row) throw new Error(`sealing the ${kind} key returned no row`);
  return new Uint8Array(
    Buffer.from(await deps.cipher.decrypt(organizationId, row.ciphertext), "base64")
  );
}

/**
 * What sealing would find, without writing anything.
 *
 * Existing material is what separates a preview from a guess: `createKeyRef`
 * preserves the blob already there, so a wallet holding keys that differ from the
 * verified derivation is one the real run will skip rather than migrate.
 */
async function previewSeal(
  deps: MigrateWalletDeps,
  wallet: HeliusRingsWalletRow,
  shieldedAddress: string,
  derived: DerivedKeyBytes
): Promise<MigrationOutcome> {
  const kinds = [
    ["viewing", derived.viewingKeyBytes],
    ["nullifier", derived.nullifierKeyBytes],
  ] as const;

  for (const [kind, expected] of kinds) {
    const row = await deps.keyRefs.getKeyRef({ walletId: wallet.id, kind });
    if (!row) continue;
    const stored = new Uint8Array(
      Buffer.from(await deps.cipher.decrypt(wallet.organization_id, row.ciphertext), "base64")
    );
    if (!sameBytes(stored, expected)) {
      return {
        kind: "skipped",
        reason: `an existing ${kind} key does not match the verified derivation; left pinned unchanged`,
      };
    }
  }

  return { kind: "migrated", shieldedAddress };
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

  const candidate = await createShieldedMaterial({ ...derived, owner: wallet.owner_address });
  let derivedIdentity: string;
  try {
    derivedIdentity = canonicalShieldedIdentity(candidate.shieldedAddress);
  } finally {
    candidate.destroy();
  }

  // Refuse anything the seed does not reproduce. Such a wallet is already broken —
  // the gateway's own identity assertion would reject it too — and importing keys
  // that do not match would only make the breakage permanent, since createKeyRef
  // never overwrites.
  if (derivedIdentity !== wallet.shielded_address) {
    return {
      kind: "skipped",
      reason: `the seed derives ${derivedIdentity}, not the published ${wallet.shielded_address}`,
    };
  }

  if (deps.dryRun) {
    return await previewSeal(deps, wallet, wallet.shielded_address, derived);
  }

  const storedViewing = await sealKey(deps, wallet, "viewing", derived.viewingKeyBytes);
  const storedNullifier = await sealKey(deps, wallet, "nullifier", derived.nullifierKeyBytes);

  // What came back is what the database authority will read on the next use. If it
  // is not what was verified above, something else sealed this wallet first and
  // re-pinning would hand it keys deriving a different identity.
  if (
    !sameBytes(storedViewing, derived.viewingKeyBytes) ||
    !sameBytes(storedNullifier, derived.nullifierKeyBytes)
  ) {
    return {
      kind: "skipped",
      reason: "stored key material does not match the verified derivation; left pinned unchanged",
    };
  }

  return (await deps.repin(wallet))
    ? { kind: "migrated", shieldedAddress: wallet.shielded_address }
    : { kind: "skipped", reason: "the wallet changed authority concurrently" };
}

interface Counters {
  migrated: number;
  repinned: number;
  alreadyMigrated: number;
  skipped: number;
  failed: number;
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
      counters.alreadyMigrated += 1;
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

  if (!env.RINGS_KEY_ENCRYPTION_KEY && !env.RINGS_KEY_KMS_KEY_NAME) {
    throw new Error(
      "RINGS_KEY_ENCRYPTION_KEY (or RINGS_KEY_KMS_KEY_NAME) must be set; it is what seals the migrated keys. " +
        "Back it up before running: losing it makes every migrated wallet unspendable."
    );
  }

  const db = getDb(env);
  const deps: MigrateWalletDeps = {
    keyRefs: createHeliusRingsKeyRefRepository(env),
    cipher: createRingsKeyCipher(env),
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
    alreadyMigrated: 0,
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

    console.info(
      `${dryRun ? "Preview" : "Done"}. migrated=${counters.migrated} ` +
        `repinned=${counters.repinned} already=${counters.alreadyMigrated} ` +
        `skipped=${counters.skipped} failed=${counters.failed}`
    );
    // Skips and failures leave wallets on the public seed, which is the condition
    // this migration exists to end, so they must not read as success.
    if (counters.skipped > 0 || counters.failed > 0) {
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
