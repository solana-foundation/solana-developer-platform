import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { readMuralOrganization } from "@sdp/payments/ramps/providers/mural/provider-data";
import {
  COUNTERPARTY_ENTITY_TYPES,
  COUNTRIES,
  type Counterparty,
  type CounterpartyFieldOptionsResponse,
  type CounterpartyResponse,
  isCountryCode,
  type ListCounterpartiesResponse,
  type ListProjectCounterpartyAccountsResponse,
} from "@sdp/types";
import type { PayoutRequirementAccount } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
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
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  advanceCounterpartyRequirements,
  assertRampProviderAvailable,
  requireCryptoRail,
} from "@/routes/payments/handlers/ramps";
import { resolveMuralRequirements } from "@/routes/payments/handlers/ramps/mural";
import type { submitCounterpartyRequirementsSchema } from "@/routes/payments/schemas";
import { resolveScope, resolveWalletAddress } from "@/routes/payments/wallets";
import { AuditService } from "@/services/audit.service";
import { assertRampProviderSurfaced } from "@/services/provider-availability.service";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";
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

type SubmitCounterpartyRequirementsInput = z.infer<typeof submitCounterpartyRequirementsSchema>;

/**
 * Checks whether a Lightspark payout submission still needs account data.
 *
 * @param c - Request context for database access.
 * @param input - Submitted provider requirements.
 * @param counterparty - Counterparty receiving the payout.
 * @param organizationId - Authenticated organization scope.
 * @param projectId - Project that owns the counterparty.
 * @returns True when the caller should return the payout tree unchanged.
 */
async function lightsparkPayoutSubmissionNeedsRequirements(
  c: AppContext,
  input: SubmitCounterpartyRequirementsInput,
  counterparty: CounterpartyRow,
  organizationId: string,
  projectId: string
): Promise<boolean> {
  if (input.provider !== "lightspark" || input.direction !== "offramp") {
    throw internalError("Only Lightspark off-ramps can collect payout account requirements.");
  }
  const collectedData = input.collectedData;
  if (collectedData === undefined || collectedData.destinationCountry === undefined) {
    return true;
  }
  if (!isCountryCode(collectedData.destinationCountry)) {
    throw badRequest("destinationCountry must be a supported ISO 3166-1 alpha-2 country code.");
  }
  if (collectedData.paymentRails !== undefined) {
    return false;
  }
  const existing = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
  ).getActiveExternalAccount({
    organizationId,
    projectId,
    counterpartyId: counterparty.id,
    provider: "lightspark",
    fiatCurrency: input.fiatCurrency,
    destinationCountry: collectedData.destinationCountry,
  });
  return existing === null || existing.external_account_reference === null;
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

  assertRampProviderSurfaced(query.data.provider, resolveSdpEnvironment(c));

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
      await resolveMuralRequirements(c, counterparty, projectId, query.data.direction)
    );
  }

  const providerAccount = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
  ).getProviderAccount({
    organizationId: auth.organizationId,
    projectId,
    counterpartyId: counterparty.id,
    provider: query.data.provider,
  });

  let payoutAccounts: PayoutRequirementAccount[] | undefined;
  if (query.data.provider === "lightspark" && query.data.direction === "offramp") {
    const rows = await createPostgresCounterpartyProviderAccountsRepository(
      getDb(c.env)
    ).listExternalAccounts({
      organizationId: auth.organizationId,
      projectId,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      fiatCurrency: query.data.fiatCurrency,
    });
    payoutAccounts = rows.map((row) => {
      if (row.destination_country === null || row.provider_status === null) {
        throw internalError("Lightspark external-account row is missing corridor data.");
      }
      return { destinationCountry: row.destination_country, status: row.provider_status };
    });
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
        providerData: counterparty.provider_data,
        cryptoToken: query.data.cryptoToken,
        fiatCurrency: query.data.fiatCurrency,
        destinationWalletAddress,
        ...(providerAccount === null
          ? {}
          : { providerCustomerReference: providerAccount.provider_customer_reference }),
      }
    );
    return success(c, requirements);
  }

  const requirements = RAMP_PROVIDER_CLIENTS[query.data.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    {
      direction: query.data.direction,
      providerData: counterparty.provider_data,
      cryptoToken: query.data.cryptoToken,
      fiatCurrency: query.data.fiatCurrency,
      ...(query.data.provider === "lightspark"
        ? { cryptoRail: requireCryptoRail(query.data.cryptoToken), payoutAccounts }
        : {}),
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

  assertRampProviderSurfaced(body.provider, resolveSdpEnvironment(c));
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
  const providerAccount = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
  ).getProviderAccount({
    organizationId: auth.organizationId,
    projectId,
    counterpartyId: counterparty.id,
    provider: input.provider,
  });
  const requirements = RAMP_PROVIDER_CLIENTS[input.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    {
      direction: input.direction,
      providerData: counterparty.provider_data,
      ...("cryptoToken" in input ? { cryptoToken: input.cryptoToken } : {}),
      ...("fiatCurrency" in input ? { fiatCurrency: input.fiatCurrency } : {}),
      ...(input.provider === "lightspark" && input.direction === "offramp"
        ? { cryptoRail: requireCryptoRail(input.cryptoToken) }
        : {}),
      ...(destinationWalletAddress ? { destinationWalletAddress } : {}),
      ...(providerAccount === null
        ? {}
        : { providerCustomerReference: providerAccount.provider_customer_reference }),
    }
  );

  if (requirements.status === "unsupported") {
    return success(c, requirements);
  }

  if (requirements.status === "collect_account") {
    if (
      await lightsparkPayoutSubmissionNeedsRequirements(
        c,
        input,
        counterparty,
        auth.organizationId,
        projectId
      )
    ) {
      return success(c, requirements);
    }
  }

  if (requirements.status === "collect" || requirements.status === "collect_counterparty") {
    const collectedData = "collectedData" in input ? input.collectedData : undefined;
    const missing = requirements.fields
      .flatMap((field) => (field.kind === "address" ? field.fields : [field]))
      .filter(
        (field) =>
          field.required && (collectedData === undefined || collectedData[field.key] === undefined)
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
