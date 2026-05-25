import type { CounterpartyEntityType, CounterpartyIdentity, CounterpartyStatus } from "@sdp/types";
import type { AppDb } from "@/db";
import type {
  ArchiveCounterpartyInput,
  CounterpartiesRepository,
  CounterpartyRow,
  CreateCounterpartyInput,
  ListCounterpartiesInput,
  ListCounterpartiesResult,
  UpdateCounterpartyInput,
} from "./counterparty.repository";
import { generateCounterpartyId } from "./counterparty.repository";

function mapCounterpartyRow(row: Record<string, unknown>): CounterpartyRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string | null,
    external_id: row.external_id as string | null,
    entity_type: row.entity_type as CounterpartyEntityType,
    display_name: row.display_name as string,
    email: row.email as string,
    identity: row.identity as CounterpartyIdentity,
    status: row.status as CounterpartyStatus,
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function getCounterpartyByIdInternal(
  db: AppDb,
  params: { counterpartyId: string; organizationId: string }
): Promise<CounterpartyRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM counterparties
         WHERE id = ?
           AND organization_id = ?`
    )
    .bind(params.counterpartyId, params.organizationId)
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
             status,
             created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
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
          input.createdBy
        )
        .run();

      return getCounterpartyByIdInternal(db, {
        counterpartyId: id,
        organizationId: input.organizationId,
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
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND status = 'active'`
        )
        .bind(
          input.externalId !== undefined,
          input.externalId ?? null,
          input.entityType ?? null,
          input.displayName ?? null,
          input.email ?? null,
          input.identity ?? null,
          input.counterpartyId,
          input.organizationId
        )
        .run();

      if (rowsAffected === 0) {
        return null;
      }

      return getCounterpartyByIdInternal(db, {
        counterpartyId: input.counterpartyId,
        organizationId: input.organizationId,
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
             AND status = 'active'`
        )
        .bind(input.counterpartyId, input.organizationId)
        .run();

      if (result === 0) {
        return null;
      }

      return getCounterpartyByIdInternal(db, {
        counterpartyId: input.counterpartyId,
        organizationId: input.organizationId,
      });
    },

    async getCounterpartyById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
             WHERE id = ?
               AND organization_id = ?
               AND status = 'active'`
        )
        .bind(params.counterpartyId, params.organizationId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(row) : null;
    },

    async getCounterpartyByExternalId(params) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
             WHERE organization_id = ?
               AND external_id = ?
               AND status = 'active'`
        )
        .bind(params.organizationId, params.externalId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(row) : null;
    },

    async listCounterparties(params: ListCounterpartiesInput): Promise<ListCounterpartiesResult> {
      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM counterparties
              WHERE organization_id = ?
                AND (?::boolean OR status = 'active')
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(params.organizationId, params.includeArchived ?? false, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM counterparties
              WHERE organization_id = ?
                AND (?::boolean OR status = 'active')`
          )
          .bind(params.organizationId, params.includeArchived ?? false)
          .first<{ total: number }>(),
      ]);

      return {
        rows: rowsResult.results.map(mapCounterpartyRow),
        total: countRow?.total ?? 0,
      };
    },
  };
}
