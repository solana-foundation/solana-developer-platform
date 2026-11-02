import { z } from "zod";
import type { DatabaseClient } from "@/db/client";
import {
  type EarnOnboardingRepository,
  type EarnOnboardingScope,
  earnOnboardingCustomerSchema,
} from "./earn-onboarding.repository";

const scopeWhere =
  "organization_id = ? AND project_id = ? AND environment = ? AND counterparty_id = ?";
const scopeValues = (scope: EarnOnboardingScope) => [
  scope.organizationId,
  scope.projectId,
  scope.environment,
  scope.counterpartyId,
];

export function createPostgresEarnOnboardingRepository(
  db: DatabaseClient
): EarnOnboardingRepository {
  return {
    async get(scope) {
      const row = await db
        .prepare(`SELECT * FROM earn_onboarding_customers WHERE ${scopeWhere}`)
        .bind(...scopeValues(scope))
        .first<Record<string, unknown>>();
      return row === null ? null : earnOnboardingCustomerSchema.parse(row);
    },
    async claim(scope, input) {
      const row = await db
        .prepare(`INSERT INTO earn_onboarding_customers
        (id, organization_id, project_id, environment, counterparty_id, moderator_guid, entity_type)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`)
        .bind(
          `earn_customer_${crypto.randomUUID()}`,
          ...scopeValues(scope),
          input.moderatorGuid,
          input.entityType
        )
        .first<Record<string, unknown>>();
      return row === null ? null : earnOnboardingCustomerSchema.parse(row);
    },
    async link(scope, input) {
      const row = await db
        .prepare(`UPDATE earn_onboarding_customers
        SET organization_guid = ?, person_guid = ?, status = 'linked', updated_at = sdp_iso_now()
        WHERE ${scopeWhere} AND moderator_guid = ? AND status = 'claimed'
        AND organization_guid IS NULL AND person_guid IS NULL RETURNING *`)
        .bind(input.organizationGuid, input.personGuid, ...scopeValues(scope), input.moderatorGuid)
        .first<Record<string, unknown>>();
      return row === null ? null : earnOnboardingCustomerSchema.parse(row);
    },
    async claimWallet(scope, owner) {
      const row = await db
        .prepare(`INSERT INTO earn_onboarding_wallets
        (id, organization_id, project_id, environment, counterparty_id, owner_address)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING owner_address`)
        .bind(`earn_wallet_${crypto.randomUUID()}`, ...scopeValues(scope), owner)
        .first();
      return row !== null;
    },
    async releaseWallet(scope, owner) {
      // Soft delete only: archiving an unverified claim frees the globally
      // shared address for the real owner while keeping the row's history. A
      // linked registration is confirmed and is never released.
      await db
        .prepare(`UPDATE earn_onboarding_wallets SET status = 'archived', updated_at = sdp_iso_now()
        WHERE ${scopeWhere} AND owner_address = ? AND status = 'claimed'`)
        .bind(...scopeValues(scope), owner)
        .run();
    },
    async linkWallet(scope, owner) {
      const row = await db
        .prepare(`UPDATE earn_onboarding_wallets SET status = 'linked'
        WHERE ${scopeWhere} AND owner_address = ? AND status = 'claimed' RETURNING owner_address`)
        .bind(...scopeValues(scope), owner)
        .first();
      return row !== null;
    },
    async findByWallet(scope, owner) {
      const row = await db
        .prepare(`SELECT c.* FROM earn_onboarding_customers c
        JOIN earn_onboarding_wallets w USING (organization_id, project_id, environment, counterparty_id)
        JOIN counterparties p ON p.id = c.counterparty_id AND p.organization_id = c.organization_id AND p.project_id = c.project_id
        WHERE c.organization_id = ? AND c.project_id = ? AND c.environment = ?
          AND w.owner_address = ? AND w.status = 'linked' AND c.status = 'linked'
          AND p.status = 'active' AND p.entity_type = c.entity_type AND c.organization_guid IS NOT NULL`)
        .bind(scope.organizationId, scope.projectId, scope.environment, owner)
        .first<Record<string, unknown>>();
      return row === null ? null : earnOnboardingCustomerSchema.parse(row);
    },
    async saveDocument(scope, encryptedReference) {
      const id = `earn_document_${crypto.randomUUID()}`;
      await db
        .prepare(`INSERT INTO earn_onboarding_documents
        (id, organization_id, project_id, environment, counterparty_id, encrypted_reference)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, ...scopeValues(scope), encryptedReference)
        .run();
      return id;
    },
    async getDocument(scope, documentId) {
      const row = await db
        .prepare(`SELECT encrypted_reference FROM earn_onboarding_documents
        WHERE id = ? AND ${scopeWhere} AND status = 'active'`)
        .bind(documentId, ...scopeValues(scope))
        .first<Record<string, unknown>>();
      if (row === null) return null;
      return z.object({ encrypted_reference: z.string() }).parse(row).encrypted_reference;
    },
  };
}
