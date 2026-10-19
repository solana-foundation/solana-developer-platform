import type { DatabaseClient } from "@/db/client";

/**
 * Seed a counterparty with one active Solana crypto-wallet account in a project, the shape a
 * transfer batch recipient or recurring payment points at.
 *
 * @param db - Test database client.
 * @param seed - The counterparty and account to seed.
 * @param seed.organizationId - The organization that owns the project.
 * @param seed.projectId - The project both rows belong to.
 * @param seed.createdBy - The user recorded as the counterparty's creator.
 * @param seed.counterpartyId - The counterparty row id.
 * @param seed.counterpartyAccountId - The account row id.
 * @param seed.walletAddress - The Solana address the account pays out to.
 * @returns Resolves once both rows are seeded.
 */
export async function seedProjectCryptoWalletCounterparty(
  db: DatabaseClient,
  seed: {
    organizationId: string;
    projectId: string;
    createdBy: string;
    counterpartyId: string;
    counterpartyAccountId: string;
    walletAddress: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO counterparties (
         id, organization_id, project_id, external_id, entity_type, display_name,
         provider_data, status, created_by
       ) VALUES (?, ?, ?, NULL, 'individual', 'Crypto Wallet Counterparty', '{}', 'active', ?)`
    )
    .bind(seed.counterpartyId, seed.organizationId, seed.projectId, seed.createdBy)
    .run();
  await db
    .prepare(
      `INSERT INTO counterparty_accounts (
         id, organization_id, project_id, counterparty_id, account_kind, label,
         details, provider_account_data, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Crypto wallet', ?, '{}', 'active', ?, ?)`
    )
    .bind(
      seed.counterpartyAccountId,
      seed.organizationId,
      seed.projectId,
      seed.counterpartyId,
      JSON.stringify({ network: "solana", address: seed.walletAddress }),
      now,
      now
    )
    .run();
}
