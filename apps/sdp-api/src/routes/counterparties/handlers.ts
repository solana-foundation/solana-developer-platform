import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { readMuralOrganization } from "@sdp/payments/ramps/providers/mural/provider-data";
import { parseCollectedFields } from "@sdp/payments/ramps/requirements";
import {
  COUNTERPARTY_ENTITY_TYPES,
  COUNTRIES,
  type Counterparty,
  type CounterpartyEntityType,
  type CounterpartyFieldOptionsResponse,
  type CounterpartyIndividualIdentity,
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
import { created, noContent, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  advanceCounterpartyRequirements,
  assertRampProviderAvailable,
} from "@/routes/payments/handlers/ramps";
import { resolveMuralRequirements } from "@/routes/payments/handlers/ramps/mural";
import type { submitCounterpartyRequirementsSchema } from "@/routes/payments/schemas";
import { resolveScope, resolveWalletAddress } from "@/routes/payments/wallets";
import { AuditService } from "@/services/audit.service";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";
import {
  counterpartyIdentitySchema,
  counterpartyIdParamsSchema,
  counterpartyRequirementsQuerySchema,
  type createCounterpartySchema,
  listCounterpartiesQuerySchema,
  listCounterpartyAccountsQuerySchema,
  type updateCounterpartySchema,
} from "./schemas";

function mapToCounterparty(row: CounterpartyRow): Counterparty {
  const base = {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    externalId: row.external_id,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return row.entity_type === "individual"
    ? { ...base, entityType: "individual", identity: row.identity }
    : { ...base, entityType: "business" };
}

export const getCounterpartyFieldOptions = async (c: AppContext) => {
  const response: CounterpartyFieldOptionsResponse = {
    fields: {
      entityTypes: COUNTERPARTY_ENTITY_TYPES,
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
    throw badRequest(z.prettifyError(query.error), {
      errors: query.error.issues,
    });
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

  if (query.data.provider === "mural" && readMuralOrganization(counterparty.provider_data).id) {
    return success(
      c,
      await resolveMuralRequirements(
        c,
        counterparty,
        projectId,
        query.data.direction,
        query.data.country,
        undefined
      )
    );
  }

  if (query.data.direction === "onramp") {
    const scope = await resolveScope(c);
    const destinationWalletAddress = resolveWalletAddress(
      scope.wallets,
      query.data.destinationWallet,
      "destinationWallet"
    );
    const requirements = RAMP_PROVIDER_CLIENTS[query.data.provider].validateCounterparty(
      mapToCounterparty(counterparty),
      {
        direction: query.data.direction,
        country: query.data.country,
        providerData: counterparty.provider_data,
        cryptoToken: query.data.cryptoToken,
        fiatCurrency: query.data.fiatCurrency,
        destinationWalletAddress,
      }
    );
    return success(c, requirements);
  }

  const requirements = RAMP_PROVIDER_CLIENTS[query.data.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    {
      direction: query.data.direction,
      country: query.data.country,
      providerData: counterparty.provider_data,
      cryptoToken: query.data.cryptoToken,
      fiatCurrency: query.data.fiatCurrency,
    }
  );
  return success(c, requirements);
};

export const submitCounterpartyRequirements = async (
  c: ValidatedBodyContext<typeof submitCounterpartyRequirementsSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  await assertRampProviderAvailable(c, body.provider, auth.organizationId);

  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw notFound("Counterparty");
  }

  const input = body;
  let destinationWalletAddress: string | undefined;
  if (input.provider === "bvnk" && input.direction === "onramp") {
    const scope = await resolveScope(c);
    destinationWalletAddress = resolveWalletAddress(
      scope.wallets,
      input.destinationWallet,
      "destinationWallet",
      scope.auth
    );
  }
  const submittedCollectedData = "collectedData" in input ? input.collectedData : undefined;
  const requirements = RAMP_PROVIDER_CLIENTS[input.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    {
      direction: input.direction,
      country: input.country,
      providerData: counterparty.provider_data,
      collectedData: submittedCollectedData,
      ...("cryptoToken" in input ? { cryptoToken: input.cryptoToken } : {}),
      ...("fiatCurrency" in input ? { fiatCurrency: input.fiatCurrency } : {}),
      ...(destinationWalletAddress ? { destinationWalletAddress } : {}),
    }
  );

  if (requirements.status === "unsupported") {
    return success(c, requirements);
  }

  if (requirements.status === "collect") {
    const missing = requirements.fields.filter(
      (field) =>
        field.required &&
        (submittedCollectedData === undefined || submittedCollectedData[field.key] === undefined)
    );
    if (missing.length > 0) {
      return success(c, { ...requirements, fields: missing });
    }
    if (submittedCollectedData === undefined) {
      throw badRequest("collectedData is required to submit counterparty requirements.");
    }
    parseCollectedFields(
      requirements.fields,
      submittedCollectedData,
      `Missing or invalid fields required for ${requirements.provider}.`
    );
  }

  const advanced = await advanceCounterpartyRequirements(c, {
    ...input,
    counterparty,
    projectId,
  });
  return success(c, advanced);
};

export const createCounterparty = async (
  c: ValidatedBodyContext<typeof createCounterpartySchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const repo = getCounterpartiesRepository(c);

  if (body.externalId) {
    const existing = await repo.getCounterpartyByExternalId({
      externalId: body.externalId,
      organizationId: auth.organizationId,
      projectId,
    });
    if (existing) {
      throw conflict("A counterparty with this external ID already exists");
    }
  }

  const createdBy = await resolveCreatorUserId(c);

  const baseInput = {
    organizationId: auth.organizationId,
    projectId,
    externalId: body.externalId === undefined ? null : body.externalId,
    displayName: body.displayName,
    email: body.email,
    providerData: {},
    createdBy,
  };
  const counterparty = await repo.createCounterparty(
    body.entityType === "individual"
      ? { ...baseInput, entityType: "individual", identity: body.identity }
      : { ...baseInput, entityType: "business" }
  );

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
      entityType: body.entityType,
    },
  });

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(counterparty) };
  return created(c, response);
};

/**
 * Rejects an update whose resulting (entityType, identity) pair would violate the
 * discriminated identity contract, loading the stored row for whichever side the
 * request omitted. Returns the re-parsed identity when the request provided one.
 */
async function validateUpdatedIdentity(
  repo: ReturnType<typeof getCounterpartiesRepository>,
  input: {
    counterpartyId: string;
    organizationId: string;
    projectId: string;
    entityType: CounterpartyEntityType | undefined;
    identity: CounterpartyIndividualIdentity | undefined;
  }
): Promise<CounterpartyIndividualIdentity | undefined> {
  if (input.identity === undefined && input.entityType === undefined) {
    return undefined;
  }
  const current = await repo.getCounterpartyById(input);
  if (!current) {
    throw notFound("Counterparty");
  }
  const entityType = input.entityType === undefined ? current.entity_type : input.entityType;
  if (entityType === "business") {
    if (input.identity !== undefined) {
      throw badRequest("Business counterparties cannot have an identity payload.");
    }
    return undefined;
  }
  if (input.identity === undefined) {
    if (current.entity_type === "business") {
      throw badRequest("Changing entityType to individual requires identity in the same request.");
    }
    return undefined;
  }
  const result = counterpartyIdentitySchema.safeParse(input.identity);
  if (!result.success) {
    throw badRequest("identity does not match the counterparty's entityType.", {
      errors: z.treeifyError(result.error),
    });
  }
  return result.data;
}

export const updateCounterparty = async (
  c: ValidatedBodyContext<typeof updateCounterpartySchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  const { counterpartyId } = params.data;
  const repo = getCounterpartiesRepository(c);

  if (body.externalId) {
    const existing = await repo.getCounterpartyByExternalId({
      externalId: body.externalId,
      organizationId: auth.organizationId,
      projectId,
    });
    if (existing && existing.id !== counterpartyId) {
      throw conflict("A counterparty with this external ID already exists");
    }
  }

  const validatedIdentity = await validateUpdatedIdentity(repo, {
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    entityType: body.entityType,
    identity: body.identity,
  });
  const update = validatedIdentity === undefined ? body : { ...body, identity: validatedIdentity };

  const updated = await repo.updateCounterparty({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    ...update,
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
    metadata: { changedFields: Object.keys(body) },
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
