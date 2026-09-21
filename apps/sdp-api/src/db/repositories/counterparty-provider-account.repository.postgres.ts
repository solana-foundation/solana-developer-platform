import type { AppDb } from "@/db";
import { internalError } from "@/lib/errors";
import type {
  ArchiveExternalAccountInput,
  AssignCustomerLinkReferenceInput,
  AssignFundingWalletReferenceInput,
  ClaimFundingWalletInput,
  CompleteExternalAccountInput,
  CounterpartyProviderAccountRow,
  CounterpartyProviderAccountsRepository,
  FindActiveFundingWalletByCustomerLinkIdInput,
  FindActiveFundingWalletByReferenceInput,
  FindCustomerLinkBySessionReferenceInput,
  GetAccountByKindAndCurrencyInput,
  GetCounterpartyProviderAccountInput,
  GetExternalAccountByIdInput,
  InsertPendingExternalAccountInput,
  InsertProviderResourceAccountInput,
  LeaseStaleFundingWalletClaimInput,
  ListActiveExternalAccountsInput,
  ListExternalAccountsInput,
  ListProviderAccountsInput,
  MarkCustomerLinkSessionTimestampInput,
  PatchAccountMetadataInput,
  SetCustomerLinkSessionInput,
  UpdateExternalAccountStatusInput,
  UpdateFundingWalletStatusInput,
  UpsertCounterpartyProviderAccountInput,
} from "./counterparty-provider-account.repository";
import {
  type BvnkSessionTimestampField,
  bvnkFundingWalletMetadataSchema,
  counterpartyProviderAccountRowSchema,
  generateCounterpartyProviderAccountId,
} from "./counterparty-provider-account.repository";

/**
 * Validates a provider-account metadata blob against the schema its row
 * kind requires. A BVNK funding row carries no metadata for the whole life
 * of the row, so it always parses against the empty shape.
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
  if (kind === "funding_wallet" && provider === "bvnk") {
    bvnkFundingWalletMetadataSchema.parse(metadata);
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

function sessionTimestampUpdateSql(field: BvnkSessionTimestampField): string {
  switch (field) {
    case "signedAt":
      return `UPDATE counterparty_provider_accounts
             SET metadata = jsonb_set(metadata, '{session,signedAt}', to_jsonb(?::text)),
                 updated_at = sdp_iso_now()
             WHERE id = ?
               AND organization_id = ?
               AND project_id = ?
               AND counterparty_id = ?
               AND provider = ?
               AND kind = 'customer_link'
               AND status = 'active'
               AND metadata->'session'->>'reference' = ?
               AND NOT jsonb_exists(metadata->'session', 'signedAt')
             RETURNING *`;
    case "consentSubmittedAt":
      return `UPDATE counterparty_provider_accounts
             SET metadata = jsonb_set(metadata, '{session,consentSubmittedAt}', to_jsonb(?::text)),
                 updated_at = sdp_iso_now()
             WHERE id = ?
               AND organization_id = ?
               AND project_id = ?
               AND counterparty_id = ?
               AND provider = ?
               AND kind = 'customer_link'
               AND status = 'active'
               AND metadata->'session'->>'reference' = ?
               AND NOT jsonb_exists(metadata->'session', 'consentSubmittedAt')
             RETURNING *`;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
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

    async claimFundingWallet(input: ClaimFundingWalletInput) {
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider,
             provider_customer_reference, kind, fiat_currency, provider_status, metadata
           ) VALUES (?, ?, ?, ?, ?, ?, 'funding_wallet', ?, ?, '{}'::jsonb)
           ON CONFLICT (counterparty_id, provider, fiat_currency)
             WHERE status = 'active' AND kind = 'funding_wallet'
           DO NOTHING
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.providerCustomerReference,
          input.fiatCurrency,
          input.providerStatus
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async assignFundingWalletReference(input: AssignFundingWalletReferenceInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET external_account_reference = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'funding_wallet'
             AND status = 'active'
             AND external_account_reference IS NULL
           RETURNING *`
        )
        .bind(
          input.externalAccountReference,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async findActiveFundingWalletByCustomerLinkId(
      input: FindActiveFundingWalletByCustomerLinkIdInput
    ) {
      const row = await db
        .prepare(
          `SELECT f.*
           FROM counterparty_provider_accounts f
           JOIN counterparty_provider_accounts l
             ON l.organization_id = f.organization_id
            AND l.project_id = f.project_id
            AND l.counterparty_id = f.counterparty_id
            AND l.provider = f.provider
           JOIN projects prj ON prj.id = f.project_id
           WHERE l.id = ?
             AND l.kind = 'customer_link'
             AND l.status = 'active'
             AND f.kind = 'funding_wallet'
             AND f.fiat_currency = ?
             AND f.status = 'active'
             AND f.provider = ?
             AND prj.environment = ?`
        )
        .bind(input.customerLinkId, input.fiatCurrency, input.provider, input.environment)
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async findActiveFundingWalletByReference(input: FindActiveFundingWalletByReferenceInput) {
      const row = await db
        .prepare(
          `SELECT f.*
           FROM counterparty_provider_accounts f
           JOIN projects prj ON prj.id = f.project_id
           WHERE f.provider = ?
             AND f.kind = 'funding_wallet'
             AND f.status = 'active'
             AND f.external_account_reference = ?
             AND prj.environment = ?`
        )
        .bind(input.provider, input.externalAccountReference, input.environment)
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async updateFundingWalletStatus(input: UpdateFundingWalletStatusInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET provider_status = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'funding_wallet'
             AND status = 'active'
             AND provider_status = ?
           RETURNING *`
        )
        .bind(
          input.toStatus,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fromStatus
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async leaseStaleFundingWalletClaim(input: LeaseStaleFundingWalletClaimInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'funding_wallet'
             AND status = 'active'
             AND external_account_reference IS NULL
             AND updated_at < ?
           RETURNING *`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.cutoff
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
      // Patch semantics (top-level shallow merge + explicit key deletion) keep
      // callers from clobbering sibling keys. The row is locked for the
      // read-merge-write and the merged blob is validated against the row
      // kind's schema BEFORE the UPDATE — an invalid blob can never persist.
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

    async assignCustomerLinkReference(input: AssignCustomerLinkReferenceInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET provider_customer_reference = ?,
               metadata = ?::jsonb,
               status = 'active',
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'customer_link'
             AND provider_customer_reference = ?
           RETURNING *`
        )
        .bind(
          input.providerCustomerReference,
          input.metadata,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fromProviderCustomerReference
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
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

    async setCustomerLinkSession(input: SetCustomerLinkSessionInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET metadata = metadata || jsonb_build_object('session', ?::jsonb),
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND kind = 'customer_link'
             AND NOT jsonb_exists(metadata, 'session')
           RETURNING *`
        )
        .bind(
          input.session,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    /**
     * Finds a webhook-targeted customer link without tenant scope.
     *
     * @param input - Provider and stored agreement-session reference.
     * @returns The matching active customer-link row, or null when it is absent.
     */
    async findCustomerLinkBySessionReference(input: FindCustomerLinkBySessionReferenceInput) {
      const row = await db
        .prepare(
          `SELECT cpa.*
           FROM counterparty_provider_accounts cpa
           JOIN projects prj ON prj.id = cpa.project_id
           WHERE cpa.provider = ?
             AND cpa.kind = 'customer_link'
             AND cpa.status = 'active'
             AND cpa.metadata->'session'->>'reference' = ?
             AND prj.environment = ?
           LIMIT 1`
        )
        .bind(input.provider, input.sessionReference, input.environment)
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },

    async markCustomerLinkSessionTimestamp(input: MarkCustomerLinkSessionTimestampInput) {
      const row = await db
        .prepare(sessionTimestampUpdateSql(input.field))
        .bind(
          input.timestamp,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.sessionReference
        )
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
        "kind IN ('payout_account', 'customer_link')",
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
