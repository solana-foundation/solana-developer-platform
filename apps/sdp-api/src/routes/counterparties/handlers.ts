import type { CounterpartyRow } from "@sdp/payments/counterparty";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  COUNTERPARTY_ENTITY_TYPES,
  type Counterparty,
  type CounterpartyFieldOptionsResponse,
  type CounterpartyResponse,
  type ListCounterpartiesResponse,
} from "@sdp/types/counterparties";
import { COUNTRIES } from "@sdp/types/countries";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { ListProjectCounterpartyAccountsResponse } from "@sdp/types/payments";
import { z } from "zod";
import { getDb } from "@/db/client";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
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
import { admitRamp } from "@/routes/payments/ramps/admission";
import {
  assertPaymentWalletExactAccess,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "@/routes/payments/wallets";
import { AuditService } from "@/services/audit.service";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";
import type { submitCounterpartyRequirementsSchema } from "./schemas";
import {
  counterpartyIdParamsSchema,
  counterpartyRequirementsQuerySchema,
  type createCounterpartySchema,
  listCounterpartiesQuerySchema,
  listCounterpartyAccountsQuerySchema,
  type updateCounterpartySchema,
} from "./schemas";

function mapToCounterparty(row: CounterpartyRow): Counterparty {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    externalId: row.external_id,
    entityType: row.entity_type,
    displayName: row.display_name,
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
      countries: COUNTRIES,
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

  await admitRamp(c, { need: "read", provider: query.data.provider });

  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw notFound("Counterparty");
  }

  const providerAccount = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
  ).getProviderAccount({
    organizationId: auth.organizationId,
    projectId,
    counterpartyId: counterparty.id,
    provider: query.data.provider,
  });

  let destinationWalletAddress: string | undefined;
  if (query.data.direction === "onramp") {
    const scope = await resolveScope(c);
    const destinationWallet = resolveWalletByCustodyWalletId(
      scope.wallets,
      query.data.destinationCustodyWalletId
    );
    assertPaymentWalletExactAccess(c, destinationWallet.id, []);
    destinationWalletAddress = destinationWallet.publicKey;
  }

  const requirements = RAMP_PROVIDER_CLIENTS[query.data.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    {
      direction: query.data.direction,
      providerData: counterparty.provider_data,
      cryptoToken: getCryptoRailAssetLabel(query.data.assetRail),
      fiatCurrency: query.data.fiatCurrency,
      ...(destinationWalletAddress === undefined ? {} : { destinationWalletAddress }),
      ...(providerAccount === null
        ? {}
        : { providerCustomerReference: providerAccount.provider_customer_reference }),
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

  await assertProviderAvailable(c, { family: "ramps", provider: body.provider });

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
  const requirements = RAMP_PROVIDER_CLIENTS[input.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    { direction: input.direction, providerData: counterparty.provider_data }
  );
  return success(c, requirements);
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

  const counterparty = await repo.createCounterparty({
    organizationId: auth.organizationId,
    projectId,
    externalId: body.externalId ?? null,
    entityType: body.entityType,
    displayName: body.displayName,
    providerData: {},
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
      entityType: body.entityType,
    },
  });

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(counterparty) };
  return created(c, response);
};

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

  const updated = await repo.updateCounterparty({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    ...body,
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
