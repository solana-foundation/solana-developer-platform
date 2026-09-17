import type { AppDb } from "@/db";
import { internalError } from "@/lib/errors";
import type {
  ArchiveExternalAccountInput,
  CompleteCustomerLinkInput,
  CompleteExternalAccountInput,
  CompleteVirtualFundingWalletReferenceInput,
  CompleteVirtualSettlementWalletReferenceInput,
  CounterpartyProviderAccountRow,
  CounterpartyProviderAccountsRepository,
  GetAccountByKindAndCurrencyInput,
  GetCounterpartyProviderAccountInput,
  GetExternalAccountByIdInput,
  GetProviderAccountByExternalReferenceInput,
  GetVirtualFundingWalletInput,
  GetVirtualSettlementWalletInput,
  InsertPendingExternalAccountInput,
  InsertPendingVirtualFundingWalletInput,
  InsertPendingVirtualSettlementWalletInput,
  InsertProviderResourceAccountInput,
  ListActiveExternalAccountsInput,
  ListExternalAccountsInput,
  ListProviderAccountsInput,
  PatchAccountMetadataInput,
  UpdateExternalAccountStatusInput,
  UpdateVirtualFundingWalletStatusInput,
  UpdateVirtualSettlementWalletStatusInput,
  UpsertCounterpartyProviderAccountInput,
} from "./counterparty-provider-account.repository";
import {
  bvnkCustomerLinkMetadataSchema,
  bvnkFundingWalletMetadataSchema,
  bvnkSettlementWalletMetadataSchema,
  counterpartyProviderAccountRowSchema,
  generateCounterpartyProviderAccountId,
  pendingCustomerLinkRowSchema,
} from "./counterparty-provider-account.repository";

/**
 * Validates a provider-account metadata blob against the schema its row
 * kind requires.
 *
 * @param kind - The row's kind discriminator.
 * @param provider - The row's ramp provider.
 * @param metadata - The metadata blob to validate.
 */
function assertProviderAccountMetadata(
  kind: CounterpartyProviderAccountRow["kind"],
  provider: CounterpartyProviderAccountRow["provider"],
  metadata: Record<string, unknown>
): void {
  if (kind === "virtual_funding_wallet" && provider === "bvnk") {
    bvnkFundingWalletMetadataSchema.parse(metadata);
  }
  if (kind === "virtual_settlement_wallet" && provider === "bvnk") {
    bvnkSettlementWalletMetadataSchema.parse(metadata);
  }
  if (kind === "customer_link" && provider === "bvnk") {
    bvnkCustomerLinkMetadataSchema.parse(metadata);
  }
}

function parseProviderAccountRow(row: Record<string, unknown>): CounterpartyProviderAccountRow {
  const parsed = counterpartyProviderAccountRowSchema.parse(row);
  assertProviderAccountMetadata(parsed.kind, parsed.provider, parsed.metadata);
  return parsed;
}

function parseProviderAccountRows(
  rows: Record<string, unknown>[]
): CounterpartyProviderAccountRow[] {
  return rows.map((row) => parseProviderAccountRow(row));
}

export function createPostgresCounterpartyProviderAccountsRepository(
  db: AppDb
): CounterpartyProviderAccountsRepository {
  return {
    async getProviderAccount(input: GetCounterpartyProviderAccountInput) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'customer_link'
             AND status = 'active'`
        )
        .bind(input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },
    async upsertProviderAccount(input: UpsertCounterpartyProviderAccountInput) {
      const metadataColumns = input.metadata === undefined ? "" : ", metadata";
      const metadataValues = input.metadata === undefined ? "" : ", ?";
      const metadataClaim = input.metadata === undefined ? "" : "EXCLUDED.metadata || ";
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider, provider_customer_reference, kind${metadataColumns}
           ) VALUES (?, ?, ?, ?, ?, ?, 'customer_link'${metadataValues})
           ON CONFLICT (counterparty_id, provider) WHERE kind = 'customer_link'
           DO UPDATE SET
             status = 'active',
             updated_at = sdp_iso_now(),
             metadata = ${metadataClaim}(CASE
               WHEN counterparty_provider_accounts.provider_customer_reference
                    = EXCLUDED.provider_customer_reference
                 THEN counterparty_provider_accounts.metadata
               WHEN coalesce(counterparty_provider_accounts.metadata -> 'mismatchedReferences', '[]'::jsonb)
                    @> to_jsonb(EXCLUDED.provider_customer_reference)
                 THEN counterparty_provider_accounts.metadata
               ELSE jsonb_set(
                 counterparty_provider_accounts.metadata,
                 '{mismatchedReferences}',
                 coalesce(counterparty_provider_accounts.metadata -> 'mismatchedReferences', '[]'::jsonb)
                   || to_jsonb(EXCLUDED.provider_customer_reference)
               )
               END)
           WHERE counterparty_provider_accounts.organization_id = EXCLUDED.organization_id
             AND counterparty_provider_accounts.project_id = EXCLUDED.project_id
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.providerCustomerReference,
          ...(input.metadata === undefined ? [] : [input.metadata])
        )
        .first<Record<string, unknown>>();

      if (row === null) {
        throw internalError("Counterparty provider-account upsert escaped its tenant scope.");
      }
      return parseProviderAccountRow(row);
    },

    async getAccountByKindAndCurrency(input: GetAccountByKindAndCurrencyInput) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = ?
             AND fiat_currency = ?
             AND status = 'active'`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.kind,
          input.fiatCurrency
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async getVirtualFundingWallet(input: GetVirtualFundingWalletInput) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'virtual_funding_wallet'
             AND fiat_currency = ?
           ORDER BY (status = 'archived') ASC, created_at ASC
           LIMIT 1`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fiatCurrency
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async getVirtualSettlementWallet(input: GetVirtualSettlementWalletInput) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'virtual_settlement_wallet'
             AND fiat_currency = ?
           ORDER BY (status = 'archived') ASC, created_at ASC
           LIMIT 1`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fiatCurrency
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async getProviderAccountByExternalReference(input: GetProviderAccountByExternalReferenceInput) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_provider_accounts
           WHERE provider = ?
             AND external_account_reference = ?
           LIMIT 1`
        )
        .bind(input.provider, input.externalAccountReference)
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async insertPendingVirtualFundingWallet(input: InsertPendingVirtualFundingWalletInput) {
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider,
             provider_customer_reference, kind, fiat_currency, status
           ) VALUES (?, ?, ?, ?, ?, NULL, 'virtual_funding_wallet', ?, 'active')
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fiatCurrency
        )
        .first<Record<string, unknown>>();

      if (row === null) {
        throw internalError("Virtual funding-wallet claim escaped its tenant scope.");
      }
      return parseProviderAccountRow(row);
    },

    async completeVirtualFundingWalletReference(input: CompleteVirtualFundingWalletReferenceInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET external_account_reference = ?,
               provider_status = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'virtual_funding_wallet'
             AND external_account_reference IS NULL
           RETURNING *`
        )
        .bind(
          input.externalAccountReference,
          input.providerStatus,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async insertPendingVirtualSettlementWallet(input: InsertPendingVirtualSettlementWalletInput) {
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider,
             provider_customer_reference, kind, fiat_currency, status
           ) VALUES (?, ?, ?, ?, ?, NULL, 'virtual_settlement_wallet', ?, 'active')
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fiatCurrency
        )
        .first<Record<string, unknown>>();

      if (row === null) {
        throw internalError("Virtual settlement-wallet claim escaped its tenant scope.");
      }
      return parseProviderAccountRow(row);
    },

    async completeVirtualSettlementWalletReference(
      input: CompleteVirtualSettlementWalletReferenceInput
    ) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET external_account_reference = ?,
               provider_status = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'virtual_settlement_wallet'
             AND external_account_reference IS NULL
           RETURNING *`
        )
        .bind(
          input.externalAccountReference,
          input.providerStatus,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async updateVirtualFundingWalletStatus(input: UpdateVirtualFundingWalletStatusInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET status = ?,
               provider_status = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'virtual_funding_wallet'
           RETURNING *`
        )
        .bind(
          input.rowStatus,
          input.providerStatus,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async updateVirtualSettlementWalletStatus(input: UpdateVirtualSettlementWalletStatusInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET status = ?,
               provider_status = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'virtual_settlement_wallet'
           RETURNING *`
        )
        .bind(
          input.rowStatus,
          input.providerStatus,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async claimPendingCustomerLink(input: GetCounterpartyProviderAccountInput) {
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider,
             provider_customer_reference, kind, status
           ) VALUES (?, ?, ?, ?, ?, NULL, 'customer_link', 'pending')
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return pendingCustomerLinkRowSchema.parse(row);
    },

    async getPendingCustomerLink(input: GetCounterpartyProviderAccountInput) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'customer_link'
             AND status = 'pending'
             AND provider_customer_reference IS NULL
           LIMIT 1`
        )
        .bind(input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row === null ? null : pendingCustomerLinkRowSchema.parse(row);
    },

    async completeCustomerLink(input: CompleteCustomerLinkInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET provider_customer_reference = ?,
               status = 'active',
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'customer_link'
             AND status = 'pending'
             AND provider_customer_reference IS NULL
           RETURNING *`
        )
        .bind(
          input.providerCustomerReference,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async insertProviderResourceAccount(input: InsertProviderResourceAccountInput) {
      assertProviderAccountMetadata(input.kind, input.provider, input.metadata);
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider,
             provider_customer_reference, kind, external_account_reference,
             fiat_currency, destination_country, payment_rail, provider_status, metadata
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.providerCustomerReference,
          input.kind,
          input.externalAccountReference,
          input.fiatCurrency,
          input.destinationCountry === undefined ? null : input.destinationCountry,
          input.paymentRail === undefined ? null : input.paymentRail,
          input.providerStatus === undefined ? null : input.providerStatus,
          input.metadata
        )
        .first<Record<string, unknown>>();

      if (row === null) {
        throw internalError("Provider resource-account insert escaped its tenant scope.");
      }
      return parseProviderAccountRow(row);
    },

    async patchAccountMetadata(input: PatchAccountMetadataInput) {
      return db.transaction(async (tx) => {
        const current = await tx
          .prepare(
            `SELECT * FROM counterparty_provider_accounts
             WHERE id = ?
               AND organization_id = ?
               AND project_id = ?
               AND counterparty_id = ?
               AND provider = ?
               AND status = 'active'
             FOR UPDATE`
          )
          .bind(
            input.id,
            input.organizationId,
            input.projectId,
            input.counterpartyId,
            input.provider
          )
          .first<Record<string, unknown>>();
        if (current === null) {
          return null;
        }

        const currentRow = parseProviderAccountRow(current);
        const metadata: Record<string, unknown> = {
          ...currentRow.metadata,
          ...input.set,
        };
        for (const key of input.unset) {
          delete metadata[key];
        }
        assertProviderAccountMetadata(currentRow.kind, currentRow.provider, metadata);

        const row = await tx
          .prepare(
            `UPDATE counterparty_provider_accounts
             SET metadata = ?,
                 updated_at = sdp_iso_now()
             WHERE id = ?
             RETURNING *`
          )
          .bind(metadata, input.id)
          .first<Record<string, unknown>>();
        if (row === null) {
          throw internalError("Provider-account metadata patch lost its locked row.");
        }
        return parseProviderAccountRow(row);
      });
    },

    async listActiveExternalAccounts(input: ListActiveExternalAccountsInput) {
      const result = await db
        .prepare(
          `SELECT *
           FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'payout_account'
             AND fiat_currency = ?
             AND destination_country = ?
             AND status = 'active'
           ORDER BY created_at ASC`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fiatCurrency,
          input.destinationCountry
        )
        .all<Record<string, unknown>>();

      return parseProviderAccountRows(result.results);
    },

    async getExternalAccountById(input: GetExternalAccountByIdInput) {
      const row = await db
        .prepare(
          `SELECT *
           FROM counterparty_provider_accounts
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'payout_account'`
        )
        .bind(input.id, input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async listExternalAccounts(input: ListExternalAccountsInput) {
      const result = await db
        .prepare(
          `SELECT *
           FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'payout_account'
             AND fiat_currency = ?
             AND status = 'active'
             AND provider_status IS NOT NULL
           ORDER BY created_at ASC`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fiatCurrency
        )
        .all<Record<string, unknown>>();

      return parseProviderAccountRows(result.results);
    },

    async listProviderAccounts(input: ListProviderAccountsInput) {
      const conditions = [
        "organization_id = ?",
        "project_id = ?",
        "counterparty_id = ?",
        "kind IN ('payout_account', 'virtual_funding_wallet', 'virtual_settlement_wallet', 'customer_link')",
        "status IN ('active', 'archived')",
      ];
      const bindings: string[] = [input.organizationId, input.projectId, input.counterpartyId];

      if (input.provider !== undefined) {
        conditions.push("provider = ?");
        bindings.push(input.provider);
      }
      if (input.fiatCurrency !== undefined) {
        conditions.push("(kind = 'customer_link' OR fiat_currency = ?)");
        bindings.push(input.fiatCurrency);
      }
      if (input.destinationCountry !== undefined) {
        conditions.push("(kind = 'customer_link' OR destination_country = ?)");
        bindings.push(input.destinationCountry);
      }

      const result = await db
        .prepare(
          `SELECT *
           FROM counterparty_provider_accounts
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at ASC`
        )
        .bind(...bindings)
        .all<Record<string, unknown>>();

      return parseProviderAccountRows(result.results);
    },

    async insertPendingExternalAccount(input: InsertPendingExternalAccountInput) {
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id,
             organization_id,
             project_id,
             counterparty_id,
             provider,
             provider_customer_reference,
             kind,
             fiat_currency,
             destination_country,
             payment_rail
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.providerCustomerReference,
          "payout_account",
          input.fiatCurrency,
          input.destinationCountry,
          input.paymentRail
        )
        .first<Record<string, unknown>>();

      if (row === null) {
        throw internalError("External provider-account reservation escaped its tenant scope.");
      }
      return parseProviderAccountRow(row);
    },

    async completeExternalAccount(input: CompleteExternalAccountInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET external_account_reference = ?,
               provider_status = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'payout_account'
             AND status = 'active'
           RETURNING *`
        )
        .bind(
          input.externalAccountReference,
          input.providerStatus,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async updateExternalAccountStatus(input: UpdateExternalAccountStatusInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET provider_status = ?,
               payment_rail = COALESCE(?, payment_rail),
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'payout_account'
             AND status = 'active'
           RETURNING *`
        )
        .bind(
          input.providerStatus,
          input.paymentRail === undefined ? null : input.paymentRail,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async archiveExternalAccount(input: ArchiveExternalAccountInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET status = 'archived',
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'payout_account'
             AND status = 'active'
           RETURNING *`
        )
        .bind(input.id, input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },
  };
}
