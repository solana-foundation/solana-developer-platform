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

/**
 * Extracts the denormalized provider reverse-lookup columns from provider data.
 *
 * @param providerData - The counterparty provider data JSON.
 * @returns The BVNK customer reference and Mural organization id, or null when absent.
 */
function providerLookupReferences(providerData: CounterpartyProviderData): {
  bvnkCustomerReference: string | null;
  muralOrganizationId: string | null;
} {
  return {
    bvnkCustomerReference: nestedString(providerData, ["bvnk", "customer", "customerReference"]),
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
              bvnk_customer_reference = ?,
              mural_organization_id = ?,
              updated_at = sdp_iso_now()
        WHERE id = ?
      RETURNING *`
    )
    .bind(providerData, refs.bvnkCustomerReference, refs.muralOrganizationId, current.id)
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
             bvnk_customer_reference, mural_organization_id, status, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
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
          refs.bvnkCustomerReference,
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
                    bvnk_customer_reference = ?,
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
            refs.bvnkCustomerReference,
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

    async findActiveCounterpartyByBvnkCustomerReference(customerReference: string) {
      const rows = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE status = 'active'
              AND (
                bvnk_customer_reference = ?
                OR (
                  bvnk_customer_reference IS NULL
                  AND provider_data->'bvnk'->'customer'->>'customerReference' = ?
                )
              )
            ORDER BY id
            LIMIT 2`
        )
        .bind(customerReference, customerReference)
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
      await mutateProviderDataLocked(db, {
        ...params,
        mutate(currentProviderData) {
          const bvnk = readRecord(currentProviderData.bvnk);
          if (bvnk === undefined) {
            return {
              ...currentProviderData,
              bvnk: { customer: params.customer },
            };
          }
          const customer = readRecord(bvnk.customer);
          if (customer === undefined) {
            return {
              ...currentProviderData,
              bvnk: { ...bvnk, customer: params.customer },
            };
          }
          return {
            ...currentProviderData,
            bvnk: {
              ...bvnk,
              customer: { ...customer, ...params.customer },
            },
          };
        },
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
