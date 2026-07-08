import type {
  CounterpartyBusinessIdentity,
  CounterpartyIndividualIdentity,
  CounterpartyProviderData,
  CounterpartyStatus,
} from "@sdp/types";
import type { AppDb } from "@/db";
import type {
  ArchiveCounterpartyInput,
  CounterpartiesRepository,
  CounterpartyRow,
  CreateCounterpartyInput,
  ListCounterpartiesInput,
  ListCounterpartiesResult,
  UpdateCounterpartyInput,
  UpsertBvnkCustomerProviderDataInput,
} from "./counterparty.repository";
import { generateCounterpartyId } from "./counterparty.repository";

function mapCounterpartyRow(row: Record<string, unknown>): CounterpartyRow {
  const base = {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    external_id: row.external_id as string | null,
    display_name: row.display_name as string,
    email: row.email as string,
    provider_data: row.provider_data as CounterpartyProviderData,
    status: row.status as CounterpartyStatus,
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
  return row.entity_type === "individual"
    ? {
        ...base,
        entity_type: "individual",
        identity: row.identity as CounterpartyIndividualIdentity,
      }
    : {
        ...base,
        entity_type: "business",
        identity: row.identity as CounterpartyBusinessIdentity,
      };
}

async function getCounterpartyByIdInternal(
  db: AppDb,
  params: { counterpartyId: string; organizationId: string; projectId: string }
): Promise<CounterpartyRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM counterparties
         WHERE id = ?
           AND organization_id = ?
           AND project_id = ?`
    )
    .bind(params.counterpartyId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();
  return row ? mapCounterpartyRow(row) : null;
}

export function createPostgresCounterpartiesRepository(db: AppDb): CounterpartiesRepository {
  return {
    async createCounterparty(input: CreateCounterpartyInput) {
      const id = generateCounterpartyId();

      await db
        .prepare(
          `INSERT INTO counterparties (
             id,
             organization_id,
             project_id,
             external_id,
             entity_type,
             display_name,
             email,
             identity,
             provider_data,
             status,
             created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '{}'::jsonb), 'active', ?)`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.externalId,
          input.entityType,
          input.displayName,
          input.email,
          input.identity,
          input.providerData ?? null,
          input.createdBy
        )
        .run();

      return getCounterpartyByIdInternal(db, {
        counterpartyId: id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateCounterparty(input: UpdateCounterpartyInput) {
      const rowsAffected = await db
        .prepare(
          `UPDATE counterparties
             SET external_id = CASE WHEN ?::boolean THEN ? ELSE external_id END,
                 entity_type = COALESCE(?, entity_type),
                 display_name = COALESCE(?, display_name),
                 email = COALESCE(?, email),
                 identity = COALESCE(?, identity),
                 provider_data = COALESCE(?, provider_data),
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'`
        )
        .bind(
          input.externalId !== undefined,
          input.externalId ?? null,
          input.entityType ?? null,
          input.displayName ?? null,
          input.email ?? null,
          input.identity ?? null,
          input.providerData ?? null,
          input.counterpartyId,
          input.organizationId,
          input.projectId
        )
        .run();

      if (rowsAffected === 0) {
        return null;
      }

      return getCounterpartyByIdInternal(db, {
        counterpartyId: input.counterpartyId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async archiveCounterparty(input: ArchiveCounterpartyInput) {
      const result = await db
        .prepare(
          `UPDATE counterparties
             SET status = 'archived',
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'`
        )
        .bind(input.counterpartyId, input.organizationId, input.projectId)
        .run();

      if (result === 0) {
        return null;
      }

      return getCounterpartyByIdInternal(db, {
        counterpartyId: input.counterpartyId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
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
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
             WHERE status = 'active'
               AND provider_data->'bvnk'->'customer'->>'customerReference' = ?
             LIMIT 1`
        )
        .bind(customerReference)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(row) : null;
    },

    async upsertBvnkCustomerProviderData(params: UpsertBvnkCustomerProviderDataInput) {
      await db
        .prepare(
          `UPDATE counterparties
             SET provider_data = jsonb_set(
                   provider_data,
                   '{bvnk,customer}',
                   coalesce(provider_data->'bvnk'->'customer', '{}'::jsonb) || ?::jsonb,
                   true),
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'`
        )
        .bind(
          JSON.stringify(params.customer),
          params.counterpartyId,
          params.organizationId,
          params.projectId
        )
        .run();
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
            params.includeArchived ?? false,
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
          .bind(params.organizationId, params.projectId, params.includeArchived ?? false)
          .first<{ total: number }>(),
      ]);

      return {
        rows: rowsResult.results.map(mapCounterpartyRow),
        total: countRow?.total ?? 0,
      };
    },
  };
}
