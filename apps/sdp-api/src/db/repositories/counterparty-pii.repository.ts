import type { CounterpartyProviderData } from "@sdp/types";
import type { DatabaseExecutor } from "@/db";

export const COUNTERPARTY_PII_MIGRATION_ID = "counterparty-pii-v1";

export type CounterpartyPiiMigrationPhase = "dual_write" | "encrypted_only";

export async function acquireCounterpartyPiiWriteLock(db: DatabaseExecutor): Promise<void> {
  await db.execute("SELECT pg_advisory_xact_lock_shared(hashtext(?))", [
    COUNTERPARTY_PII_MIGRATION_ID,
  ]);
}

export async function acquireCounterpartyPiiLifecycleLock(db: DatabaseExecutor): Promise<void> {
  // biome-ignore lint/security/noSecrets: PostgreSQL advisory-lock function, not a credential.
  await db.execute("SELECT pg_advisory_xact_lock(hashtext(?))", [COUNTERPARTY_PII_MIGRATION_ID]);
}

export async function getCounterpartyPiiMigrationPhase(
  db: DatabaseExecutor
): Promise<CounterpartyPiiMigrationPhase> {
  const row = await db
    .prepare(
      `SELECT phase
         FROM counterparty_pii_migration_state
        WHERE id = ?`
    )
    .bind(COUNTERPARTY_PII_MIGRATION_ID)
    .first<{ phase: CounterpartyPiiMigrationPhase }>();
  if (!row) {
    throw new Error("Counterparty PII migration state is missing");
  }
  return row.phase;
}

export async function recordCounterpartyPiiFallbackRead(db: DatabaseExecutor): Promise<void> {
  await db
    .prepare(
      `UPDATE counterparty_pii_migration_state
          SET fallback_read_count = fallback_read_count + 1,
              last_fallback_read_at = sdp_iso_now(),
              updated_at = sdp_iso_now()
        WHERE id = ?`
    )
    .bind(COUNTERPARTY_PII_MIGRATION_ID)
    .run();
}

function nestedString(value: unknown, path: readonly string[]): string | null {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

export function providerLookupReferences(providerData: CounterpartyProviderData): {
  bvnkCustomerReference: string | null;
  muralOrganizationId: string | null;
} {
  return {
    bvnkCustomerReference: nestedString(providerData, ["bvnk", "customer", "customerReference"]),
    muralOrganizationId: nestedString(providerData, ["mural", "organization", "id"]),
  };
}

export function cryptoAccountLookup(details: Record<string, unknown>): {
  network: string | null;
  address: string | null;
} {
  return {
    network: typeof details.network === "string" ? details.network : null,
    address: typeof details.address === "string" ? details.address : null,
  };
}
