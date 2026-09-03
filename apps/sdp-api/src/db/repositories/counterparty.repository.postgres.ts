import { readRecord } from "@sdp/payments/json";
import type { CounterpartyProviderData, CounterpartyStatus } from "@sdp/types";
import type { AppDb, DatabaseExecutor } from "@/db";
import { internalError } from "@/lib/errors";
import type {
  ArchiveCounterpartyInput,
  CounterpartiesRepository,
  CounterpartyRow,
  CreateCounterpartyInput,
  ListCounterpartiesInput,
  ListCounterpartiesResult,
  MutateCounterpartyProviderDataInput,
  UpdateCounterpartyInput,
  UpsertBvnkCustomerProviderDataInput,
} from "./counterparty.repository";
import { generateCounterpartyId } from "./counterparty.repository";
import {
  type BvnkCustomerProviderAccountMetadata,
  bvnkCustomerProviderAccountMetadataSchema,
} from "./counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "./counterparty-provider-account.repository.postgres";

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw internalError(`Counterparty ${field} is missing`);
  }
  return value;
}

function assertNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw internalError(`Counterparty ${field} is invalid`);
  }
  return value;
}

function assertStatus(value: unknown): CounterpartyStatus {
  if (value !== "active" && value !== "archived") {
    throw internalError(`Counterparty status is invalid: ${String(value)}`);
  }
  return value;
}

function assertProviderData(value: unknown): CounterpartyProviderData {
  const providerData = readRecord(value);
  if (providerData === undefined) {
    throw internalError("Counterparty provider_data is invalid");
  }
  return providerData;
}

function nestedString(value: unknown, path: readonly string[]): string | null {
  let current = value;
  for (const part of path) {
    const record = readRecord(current);
    if (record === undefined) {
      return null;
    }
    current = record[part];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function providerLookupReferences(providerData: CounterpartyProviderData): {
  muralOrganizationId: string | null;
} {
  return {
    muralOrganizationId: nestedString(providerData, ["mural", "organization", "id"]),
  };
}

function mapCounterpartyRow(row: Record<string, unknown>): CounterpartyRow {
  const entityType = assertString(row.entity_type, "entity_type");
  if (entityType !== "individual" && entityType !== "business") {
    throw internalError(`Counterparty entity_type is invalid: ${entityType}`);
  }
  return {
    id: assertString(row.id, "id"),
    organization_id: assertString(row.organization_id, "organization_id"),
    project_id: assertString(row.project_id, "project_id"),
    external_id: assertNullableString(row.external_id, "external_id"),
    entity_type: entityType,
    display_name: assertString(row.display_name, "display_name"),
    provider_data: assertProviderData(row.provider_data),
    status: assertStatus(row.status),
    created_by: assertNullableString(row.created_by, "created_by"),
    created_at: assertString(row.created_at, "created_at"),
    updated_at: assertString(row.updated_at, "updated_at"),
  };
}

async function updateProviderData(
  db: DatabaseExecutor,
  current: CounterpartyRow,
  providerData: CounterpartyProviderData
): Promise<CounterpartyRow | null> {
  const refs = providerLookupReferences(providerData);
  const row = await db
    .prepare(
      `UPDATE counterparties
          SET provider_data = ?,
              mural_organization_id = ?,
              updated_at = sdp_iso_now()
        WHERE id = ?
      RETURNING *`
    )
    .bind(providerData, refs.muralOrganizationId, current.id)
    .first<Record<string, unknown>>();
  return row ? mapCounterpartyRow(row) : null;
}

async function mutateProviderDataLocked(
  db: AppDb,
  params: MutateCounterpartyProviderDataInput
): Promise<CounterpartyRow | null> {
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `SELECT * FROM counterparties
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
            AND status = 'active'
          FOR UPDATE`
      )
      .bind(params.counterpartyId, params.organizationId, params.projectId)
      .first<Record<string, unknown>>();
    if (!row) {
      return null;
    }
    const current = mapCounterpartyRow(row);
    return updateProviderData(tx, current, params.mutate(current.provider_data));
  });
}

export function createPostgresCounterpartiesRepository(db: AppDb): CounterpartiesRepository {
  return {
    async createCounterparty(input: CreateCounterpartyInput) {
      const id = generateCounterpartyId();
      const refs = providerLookupReferences(input.providerData);

      const row = await db
        .prepare(
          `INSERT INTO counterparties (
             id, organization_id, project_id, external_id, entity_type,
             display_name, provider_data,
             mural_organization_id, status, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.externalId,
          input.entityType,
          input.displayName,
          input.providerData,
          refs.muralOrganizationId,
          input.createdBy
        )
        .first<Record<string, unknown>>();

      return row ? mapCounterpartyRow(row) : null;
    },

    async updateCounterparty(input: UpdateCounterpartyInput) {
      return db.transaction(async (tx) => {
        const row = await tx
          .prepare(
            `SELECT * FROM counterparties
              WHERE id = ?
                AND organization_id = ?
                AND project_id = ?
                AND status = 'active'
              FOR UPDATE`
          )
          .bind(input.counterpartyId, input.organizationId, input.projectId)
          .first<Record<string, unknown>>();
        if (!row) {
          return null;
        }
        const current = mapCounterpartyRow(row);
        const providerData = input.providerData ?? current.provider_data;
        const refs = providerLookupReferences(providerData);

        const updated = await tx
          .prepare(
            `UPDATE counterparties
                SET external_id = CASE WHEN ?::boolean THEN ? ELSE external_id END,
                    entity_type = ?,
                    display_name = ?,
                    provider_data = ?,
                    mural_organization_id = ?,
                    updated_at = sdp_iso_now()
              WHERE id = ?
            RETURNING *`
          )
          .bind(
            input.externalId !== undefined,
            input.externalId ?? null,
            input.entityType ?? current.entity_type,
            input.displayName ?? current.display_name,
            providerData,
            refs.muralOrganizationId,
            current.id
          )
          .first<Record<string, unknown>>();

        return updated ? mapCounterpartyRow(updated) : null;
      });
    },

    async archiveCounterparty(input: ArchiveCounterpartyInput) {
      const row = await db
        .prepare(
          `UPDATE counterparties
              SET status = 'archived',
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = 'active'
          RETURNING *`
        )
        .bind(input.counterpartyId, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(row) : null;
    },

    async getCounterpartyById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = 'active'`
        )
        .bind(params.counterpartyId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(row) : null;
    },

    async getCounterpartyByExternalId(params) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE organization_id = ?
              AND project_id = ?
              AND external_id = ?
              AND status = 'active'`
        )
        .bind(params.organizationId, params.projectId, params.externalId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(row) : null;
    },

    async findActiveCounterpartyById(counterpartyId: string) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE id = ?
              AND status = 'active'
            LIMIT 1`
        )
        .bind(counterpartyId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(row) : null;
    },

    async findActiveCounterpartyByProviderCustomerReference(params) {
      const rows = await db
        .prepare(
          `SELECT c.*
             FROM counterparties c
             JOIN counterparty_provider_accounts cpa
               ON cpa.counterparty_id = c.id
              AND cpa.organization_id = c.organization_id
              AND cpa.project_id = c.project_id
            WHERE c.status = 'active'
              AND cpa.provider = ?
              AND cpa.provider_customer_reference = ?
              AND cpa.kind = 'customer_link'
              AND cpa.status = 'active'
            ORDER BY c.id
            LIMIT 2`
        )
        .bind(params.provider, params.providerCustomerReference)
        .all<Record<string, unknown>>();
      if (rows.results.length !== 1) {
        return null;
      }
      return mapCounterpartyRow(rows.results[0]);
    },

    async findCounterpartyByMuralOrganizationId(organizationId: string) {
      const rows = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE status = 'active'
              AND (
                mural_organization_id = ?
                OR (
                  mural_organization_id IS NULL
                  AND provider_data->'mural'->'organization'->>'id' = ?
                )
              )
            ORDER BY id
            LIMIT 2`
        )
        .bind(organizationId, organizationId)
        .all<Record<string, unknown>>();
      if (rows.results.length !== 1) {
        return null;
      }
      return mapCounterpartyRow(rows.results[0]);
    },

    async mutateProviderData(params) {
      return mutateProviderDataLocked(db, params);
    },

    async upsertBvnkCustomerProviderData(params: UpsertBvnkCustomerProviderDataInput) {
      const providerCustomerReference = params.customer.customerReference;
      if (providerCustomerReference === undefined) {
        throw internalError("BVNK customer reference is missing from provider-account state.");
      }
      const metadata: BvnkCustomerProviderAccountMetadata = {};
      if (params.customer.status !== undefined) {
        metadata.status = params.customer.status;
      }
      if (params.customer.verificationStatus !== undefined) {
        metadata.verificationStatus = params.customer.verificationStatus;
      }
      if (params.customer.contactId !== undefined) {
        metadata.contactId = params.customer.contactId;
      }
      if (params.customer.agreements !== undefined) {
        metadata.agreements = params.customer.agreements;
      }
      const parsedMetadata = bvnkCustomerProviderAccountMetadataSchema.parse(metadata);
      await createPostgresCounterpartyProviderAccountsRepository(db).upsertProviderAccount({
        organizationId: params.organizationId,
        projectId: params.projectId,
        counterpartyId: params.counterpartyId,
        provider: "bvnk",
        providerCustomerReference,
        metadata: parsedMetadata,
      });
    },

    async patchMuralOrganizationById(params) {
      await db.transaction(async (tx) => {
        const row = await tx
          .prepare(
            `SELECT * FROM counterparties
              WHERE status = 'active'
                AND (
                  mural_organization_id = ?
                  OR (
                    mural_organization_id IS NULL
                    AND provider_data->'mural'->'organization'->>'id' = ?
                  )
                )
              LIMIT 1
              FOR UPDATE`
          )
          .bind(params.organizationId, params.organizationId)
          .first<Record<string, unknown>>();
        if (!row) {
          return;
        }
        const current = mapCounterpartyRow(row);
        const mural = readRecord(current.provider_data.mural);
        if (mural === undefined) {
          await updateProviderData(tx, current, {
            ...current.provider_data,
            mural: { organization: params.organization },
          });
          return;
        }
        const organization = readRecord(mural.organization);
        if (organization === undefined) {
          await updateProviderData(tx, current, {
            ...current.provider_data,
            mural: { ...mural, organization: params.organization },
          });
          return;
        }
        await updateProviderData(tx, current, {
          ...current.provider_data,
          mural: {
            ...mural,
            organization: { ...organization, ...params.organization },
          },
        });
      });
    },

    async listCounterparties(params: ListCounterpartiesInput): Promise<ListCounterpartiesResult> {
      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM counterparties
              WHERE organization_id = ?
                AND project_id = ?
                AND (?::boolean OR status = 'active')
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(
            params.organizationId,
            params.projectId,
            params.includeArchived,
            params.limit,
            params.offset
          )
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM counterparties
              WHERE organization_id = ?
                AND project_id = ?
                AND (?::boolean OR status = 'active')`
          )
          .bind(params.organizationId, params.projectId, params.includeArchived)
          .first<{ total: number }>(),
      ]);

      if (countRow === null) {
        throw internalError("Counterparty count query returned no row");
      }
      return {
        rows: rowsResult.results.map((row) => mapCounterpartyRow(row)),
        total: countRow.total,
      };
    },
  };
}
