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
  type ListProjectCounterpartyAccountsResponse,
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
import { bvnkOnrampStatusFromProviderData } from "@/lib/ramps/providers/bvnk";
import { created, noContent, success } from "@/lib/response";
import {
  advanceCounterpartyRequirements,
  assertRampProviderAvailable,
} from "@/routes/payments/handlers/ramps";
import { submitCounterpartyRequirementsSchema } from "@/routes/payments/schemas";
import { resolveScope, resolveWalletAddress } from "@/routes/payments/wallets";
import { AuditService } from "@/services/audit.service";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";
import {
  counterpartyIdParamsSchema,
  counterpartyRequirementsQuerySchema,
  createCounterpartySchema,
  listCounterpartiesQuerySchema,
  listCounterpartyAccountsQuerySchema,
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

/**
 * Lists a project's counterparty accounts of the requested `type`.
 *
 * Only `crypto_account` is supported today (active Solana wallets); the `type`
 * enum will widen as other account kinds gain pickers, at which point the
 * response becomes a discriminated union by `type`.
 */
export const listProjectCounterpartyAccounts = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listCounterpartyAccountsQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, search } = parsed.data;
  const accountIds = parsed.data.ids
    ? parsed.data.ids
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : undefined;
  const resolvingIds = accountIds !== undefined && accountIds.length > 0;

  const repo = getCounterpartyAccountsRepository(c);
  const { rows, total } = await repo.listBatchRecipients({
    organizationId: auth.organizationId,
    projectId,
    search,
    accountIds,
    limit: resolvingIds ? accountIds.length : pageSize,
    offset: resolvingIds ? 0 : (page - 1) * pageSize,
  });

  const response: ListProjectCounterpartyAccountsResponse = {
    accounts: rows.map((row) => ({
      counterpartyId: row.counterparty_id,
      counterpartyAccountId: row.account_id,
      name: row.counterparty_display_name,
      address: row.address,
      label: row.account_label,
    })),
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

  if (
    query.data.provider === "bvnk" &&
    query.data.direction === "onramp" &&
    query.data.cryptoToken &&
    query.data.destinationWallet &&
    query.data.fiatCurrency
  ) {
    const gate = RAMP_PROVIDER_CLIENTS.bvnk.validateCounterparty(mapToCounterparty(counterparty), {
      direction: "onramp",
      providerData: counterparty.provider_data,
    });
    if (gate.status === "collect" || gate.status === "unsupported") {
      return success(c, gate);
    }
    const scope = await resolveScope(c);
    const destinationWalletAddress = resolveWalletAddress(
      scope.wallets,
      query.data.destinationWallet,
      "destinationWallet"
    );
    return success(
      c,
      bvnkOnrampStatusFromProviderData(counterparty.provider_data, {
        cryptoToken: query.data.cryptoToken,
        fiatCurrency: query.data.fiatCurrency,
        destinationWalletAddress,
      })
    );
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

export const submitCounterpartyRequirements = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = submitCounterpartyRequirementsSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  await assertRampProviderAvailable(c, parsed.data.provider, auth.organizationId);

  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw notFound("Counterparty");
  }

  const input = parsed.data;
  const requirements = RAMP_PROVIDER_CLIENTS[input.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    {
      direction: input.direction,
      providerData: counterparty.provider_data,
      ...("fiatCurrency" in input ? { fiatCurrency: input.fiatCurrency } : {}),
    }
  );

  if (requirements.status === "unsupported") {
    return success(c, requirements);
  }

  if (requirements.status === "collect") {
    const collectedData = "collectedData" in input ? input.collectedData : undefined;
    const missing = requirements.fields.filter(
      (field) => !collectedData || collectedData[field.key] === undefined
    );
    if (missing.length > 0) {
      return success(c, { ...requirements, fields: missing });
    }
  }

  const advanced = await advanceCounterpartyRequirements(c, {
    ...input,
    counterparty,
    projectId,
  });
  return success(c, advanced);
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
