import {
  COUNTERPARTY_EMPLOYMENT_STATUSES,
  COUNTERPARTY_ENTITY_TYPES,
  COUNTERPARTY_ID_TYPES,
  COUNTERPARTY_INDUSTRY_SECTORS,
  COUNTERPARTY_INTENDED_USE,
  COUNTERPARTY_PEP_STATUSES,
  COUNTERPARTY_SOURCE_OF_FUNDS,
  COUNTERPARTY_YEARLY_INCOME,
  COUNTRIES,
  type Counterparty,
  type CounterpartyFieldOptionsResponse,
  type CounterpartyResponse,
  type ListCounterpartiesResponse,
  US_STATES,
} from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import {
  badRequest,
  badRequestParams,
  badRequestQuery,
  conflict,
  internalError,
  notFound,
} from "@/lib/errors";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { type AppContext, getCounterpartiesRepository } from "./context";
import {
  counterpartyIdParamsSchema,
  counterpartyRequirementsQuerySchema,
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
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const getCounterpartyFieldOptions = async (c: AppContext) => {
  const response: CounterpartyFieldOptionsResponse = {
    fields: {
      entityTypes: COUNTERPARTY_ENTITY_TYPES,
      governmentIdTypes: COUNTERPARTY_ID_TYPES,
      compliance: {
        employmentStatuses: COUNTERPARTY_EMPLOYMENT_STATUSES,
        sourceOfFunds: COUNTERPARTY_SOURCE_OF_FUNDS,
        pepStatuses: COUNTERPARTY_PEP_STATUSES,
        intendedUseOfAccount: COUNTERPARTY_INTENDED_USE,
        estimatedYearlyIncome: COUNTERPARTY_YEARLY_INCOME,
        employmentIndustrySectors: COUNTERPARTY_INDUSTRY_SECTORS,
      },
      countries: COUNTRIES,
      usStates: US_STATES,
    },
  };
  return success(c, response);
};

export const listCounterparties = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listCounterpartiesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, includeArchived } = parsed.data;

  const repo = getCounterpartiesRepository(c);
  const { rows, total } = await repo.listCounterparties({
    organizationId: auth.organizationId,
    projectId,
    includeArchived,
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
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw notFound("Counterparty");
  }

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(counterparty) };
  return success(c, response);
};

export const getCounterpartyRequirements = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const query = counterpartyRequirementsQuerySchema.safeParse(c.req.query());

  if (!query.success) {
    throw badRequestQuery({ errors: z.treeifyError(query.error) });
  }

  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw notFound("Counterparty");
  }

  const requirements = RAMP_PROVIDER_CLIENTS[query.data.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    {
      direction: query.data.direction,
      providerData: counterparty.provider_data,
      ...("fiatCurrency" in query.data ? { fiatCurrency: query.data.fiatCurrency } : {}),
    }
  );
  return success(c, requirements);
};

export const createCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
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
      projectId,
    });
    if (existing) {
      throw conflict("A counterparty with this external ID already exists");
    }
  }

  const createdBy = await resolveCreatorUserId(c);

  const counterparty = await repo.createCounterparty({
    organizationId: auth.organizationId,
    projectId,
    externalId: parsed.data.externalId ?? null,
    entityType: parsed.data.entityType,
    displayName: parsed.data.displayName,
    email: parsed.data.email,
    identity: parsed.data.identity ?? {},
    createdBy,
  });

  if (!counterparty) {
    throw internalError("Failed to create counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
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
  const projectId = requireProjectId(c);
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
      projectId,
    });
    if (existing && existing.id !== counterpartyId) {
      throw conflict("A counterparty with this external ID already exists");
    }
  }

  const updated = await repo.updateCounterparty({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    ...parsed.data,
  });

  if (!updated) {
    throw notFound("Counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "update",
    resourceType: "counterparty",
    resourceId: counterpartyId,
    metadata: { changedFields: Object.keys(parsed.data) },
  });

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(updated) };
  return success(c, response);
};

export const archiveCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const { counterpartyId } = params.data;
  const repo = getCounterpartiesRepository(c);

  const archived = await repo.archiveCounterparty({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!archived) {
    throw notFound("Counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "delete",
    resourceType: "counterparty",
    resourceId: counterpartyId,
  });

  return noContent(c);
};
