import type { Counterparty, CounterpartyResponse, ListCounterpartiesResponse } from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { getAuth } from "@/lib/auth";
import {
  AppError,
  badRequest,
  badRequestParams,
  badRequestQuery,
  conflict,
  notFound,
} from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { type AppContext, getCounterpartiesRepository } from "./context";
import {
  counterpartyIdParamsSchema,
  createCounterpartySchema,
  listCounterpartiesQuerySchema,
  updateCounterpartySchema,
} from "./schemas";

function mapToCounterparty(row: CounterpartyRow): Counterparty {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    externalId: row.external_id,
    entityType: row.entity_type,
    displayName: row.display_name,
    email: row.email,
    identity: row.identity,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const listCounterparties = async (c: AppContext) => {
  const auth = getAuth(c);
  const parsed = listCounterpartiesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, includeInactive } = parsed.data;

  const repo = getCounterpartiesRepository(c);
  const { rows, total } = await repo.listCounterparties({
    organizationId: auth.organizationId,
    includeInactive,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListCounterpartiesResponse = {
    counterparties: rows.map(mapToCounterparty),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
  });

  if (!counterparty) {
    throw notFound("Counterparty");
  }

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(counterparty) };
  return success(c, response);
};

export const createCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const body = await c.req.json();
  const parsed = createCounterpartySchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const repo = getCounterpartiesRepository(c);

  if (parsed.data.externalId) {
    const existing = await repo.getCounterpartyByExternalId({
      externalId: parsed.data.externalId,
      organizationId: auth.organizationId,
    });
    if (existing) {
      throw conflict("A counterparty with this external ID already exists");
    }
  }

  const counterparty = await repo.createCounterparty({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    externalId: parsed.data.externalId ?? null,
    entityType: parsed.data.entityType,
    displayName: parsed.data.displayName,
    email: parsed.data.email,
    identity: parsed.data.identity ?? {},
    createdBy: auth.userId,
  });

  if (!counterparty) {
    throw new AppError("INTERNAL_ERROR", "Failed to create counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "create",
    resourceType: "counterparty",
    resourceId: counterparty.id,
    metadata: {
      entityType: parsed.data.entityType,
      externalId: parsed.data.externalId,
    },
  });

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(counterparty) };
  return created(c, response);
};

export const updateCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = updateCounterpartySchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { counterpartyId } = params.data;
  const repo = getCounterpartiesRepository(c);

  if (parsed.data.externalId) {
    const existing = await repo.getCounterpartyByExternalId({
      externalId: parsed.data.externalId,
      organizationId: auth.organizationId,
    });
    if (existing && existing.id !== counterpartyId) {
      throw conflict("A counterparty with this external ID already exists");
    }
  }

  const updated = await repo.updateCounterparty({
    counterpartyId,
    organizationId: auth.organizationId,
    ...parsed.data,
  });

  if (!updated) {
    throw notFound("Counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "counterparty",
    resourceId: counterpartyId,
    metadata: parsed.data as Record<string, unknown>,
  });

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(updated) };
  return success(c, response);
};

export const archiveCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const { counterpartyId } = params.data;
  const repo = getCounterpartiesRepository(c);

  const archived = await repo.archiveCounterparty({
    counterpartyId,
    organizationId: auth.organizationId,
  });

  if (!archived) {
    throw notFound("Counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "counterparty",
    resourceId: counterpartyId,
  });

  return noContent(c);
};
