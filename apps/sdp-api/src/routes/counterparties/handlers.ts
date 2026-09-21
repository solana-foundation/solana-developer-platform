import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { BvnkCustomerResolution } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  bvnkCustomerStatusRequirements,
  isBvnkCustomerVerified,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { bvnkCustomerStatusSchema } from "@sdp/payments/ramps/providers/bvnk/schemas";
import { readMuralOrganization } from "@sdp/payments/ramps/providers/mural/provider-data";
import { readyCounterparty } from "@sdp/payments/ramps/requirements";
import type { RampDirection } from "@sdp/types";
import {
  COUNTERPARTY_ENTITY_TYPES,
  COUNTRIES,
  type Counterparty,
  type CounterpartyFieldOptionsResponse,
  type CounterpartyResponse,
  getCryptoRailAssetLabel,
  isCountryCode,
  type ListCounterpartiesResponse,
  type ListProjectCounterpartyAccountsResponse,
} from "@sdp/types";
import type {
  CounterpartyRequirements,
  PayoutRequirementAccount,
} from "@sdp/types/ramp-requirements";
import { isCollectFieldsRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { bvnkCustomerProviderAccountMetadataSchema } from "@/db/repositories/counterparty-provider-account.repository";
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
import { rampRuntime } from "@/routes/payments/context";
import {
  advanceCounterpartyRequirements,
  assertRampProviderAvailable,
} from "@/routes/payments/handlers/ramps";
import {
  type BvnkStoredStage,
  bvnkCustomerRequirementsFromMetadata,
  bvnkFundingWalletRequirements,
  bvnkStoredStage,
  presentBvnkStoredStage,
  refreshBvnkCustomerAccount,
} from "@/routes/payments/handlers/ramps/bvnk";
import { resolveMuralRequirements } from "@/routes/payments/handlers/ramps/mural";
import type { submitCounterpartyRequirementsSchema } from "@/routes/payments/schemas";
import {
  assertPaymentWalletExactAccess,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "@/routes/payments/wallets";
import { AuditService } from "@/services/audit.service";
import { mapPayoutRequirementAccounts } from "@/services/payments/payout-requirement-accounts";
import { enrichCounterpartyProviderAccounts } from "@/services/payments/provider-account-enrichment";
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
  if (input.providerAccountId !== undefined || collectedData.paymentRails !== undefined) {
    return false;
  }
  const existing = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
  ).listActiveExternalAccounts({
    organizationId,
    projectId,
    counterpartyId: counterparty.id,
    provider: "lightspark",
    fiatCurrency: input.fiatCurrency,
    destinationCountry: collectedData.destinationCountry,
  });
  return existing.length !== 1 || existing[0].external_account_reference === null;
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

  let refreshedBvnkCustomer:
    | { customer: BvnkCustomerResolution; verificationUrl: string | undefined }
    | undefined;
  if (query.data.provider === "bvnk" && providerAccount !== null) {
    const metadata = bvnkCustomerProviderAccountMetadataSchema.parse(providerAccount.metadata);
    const storedRequirements = bvnkCustomerRequirementsFromMetadata(query.data.direction, metadata);
    if (storedRequirements) {
      return success(c, storedRequirements);
    }
    refreshedBvnkCustomer = await refreshBvnkCustomerAccount(c.env, rampRuntime(c), {
      counterparty,
      projectId,
      providerAccountId: providerAccount.id,
      customerReference: providerAccount.provider_customer_reference,
    });
    if (!isBvnkCustomerVerified(refreshedBvnkCustomer.customer.status)) {
      return success(
        c,
        bvnkCustomerStatusRequirements(
          bvnkCustomerStatusSchema.parse(refreshedBvnkCustomer.customer.status),
          query.data.direction,
          refreshedBvnkCustomer.verificationUrl
        )
      );
    }
  }

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
    const enriched = await enrichCounterpartyProviderAccounts(rampRuntime(c), rows);
    payoutAccounts = mapPayoutRequirementAccounts(rows, enriched);
  }

  if (query.data.direction === "onramp") {
    const scope = await resolveScope(c);
    const destinationWallet = resolveWalletByCustodyWalletId(
      scope.wallets,
      query.data.destinationCustodyWalletId
    );
    assertPaymentWalletExactAccess(c, destinationWallet.id, []);
    const destinationWalletAddress = destinationWallet.publicKey;
    if (query.data.provider === "bvnk" && refreshedBvnkCustomer !== undefined) {
      const funding = await bvnkFundingWalletRequirements(c, {
        counterparty,
        projectId,
        direction: query.data.direction,
      });
      if (funding !== null) {
        return success(c, funding);
      }
      return success(c, readyCounterparty("bvnk", query.data.direction));
    }
    const requirements = RAMP_PROVIDER_CLIENTS[query.data.provider].validateCounterparty(
      mapToCounterparty(counterparty),
      {
        direction: query.data.direction,
        providerData: counterparty.provider_data,
        cryptoToken: getCryptoRailAssetLabel(query.data.assetRail),
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
      cryptoToken: getCryptoRailAssetLabel(query.data.assetRail),
      fiatCurrency: query.data.fiatCurrency,
      ...(query.data.provider === "lightspark"
        ? {
            cryptoRail: query.data.assetRail,
            payoutAccounts,
            destinationCountry: query.data.destinationCountry,
          }
        : {}),
      ...(providerAccount === null
        ? {}
        : { providerCustomerReference: providerAccount.provider_customer_reference }),
    }
  );
  return success(c, requirements);
};

/**
 * Requirements a BVNK submit presents instead of the provider client's
 * stage-blind validation: the stored collect form once the session is signed,
 * or the signing wait state while consent awaits the provider's confirmation.
 *
 * @param direction - Ramp direction used in the requirement response.
 * @param stage - Stored pre-customer stage of the customer-link row, or null once the customer exists.
 * @returns The stage-derived requirement, or null when the client validation stands.
 */
function bvnkStoredSubmitRequirements(
  direction: RampDirection,
  stage: BvnkStoredStage | null
): CounterpartyRequirements | null {
  if (stage === null) {
    return null;
  }
  switch (stage.kind) {
    case "collect_counterparty":
    case "agreements_submitted":
      return presentBvnkStoredStage(direction, stage);
    case "agreements_pending":
    case "session_pending":
      return null;
    default: {
      const exhaustive: never = stage;
      throw internalError(`Unhandled BVNK stored stage: ${String(exhaustive)}`);
    }
  }
}

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
    const destinationWallet = resolveWalletByCustodyWalletId(
      scope.wallets,
      input.destinationCustodyWalletId
    );
    assertPaymentWalletExactAccess(c, destinationWallet.id, []);
    destinationWalletAddress = destinationWallet.publicKey;
  }
  const providerAccount = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
  ).getProviderAccount({
    organizationId: auth.organizationId,
    projectId,
    counterpartyId: counterparty.id,
    provider: input.provider,
  });
  let requirements = RAMP_PROVIDER_CLIENTS[input.provider].validateCounterparty(
    mapToCounterparty(counterparty),
    {
      direction: input.direction,
      providerData: counterparty.provider_data,
      ...("assetRail" in input ? { cryptoToken: getCryptoRailAssetLabel(input.assetRail) } : {}),
      ...("fiatCurrency" in input ? { fiatCurrency: input.fiatCurrency } : {}),
      ...(input.provider === "lightspark" && input.direction === "offramp"
        ? { cryptoRail: input.assetRail }
        : {}),
      ...(destinationWalletAddress ? { destinationWalletAddress } : {}),
      ...(providerAccount === null
        ? {}
        : { providerCustomerReference: providerAccount.provider_customer_reference }),
      ...("collectedData" in input ? { collectedData: input.collectedData } : {}),
    }
  );

  if (requirements.status === "unsupported") {
    return success(c, requirements);
  }

  let gateOnCollectedFields = true;
  if (input.provider === "bvnk" && providerAccount !== null) {
    const stage = bvnkStoredStage(
      bvnkCustomerProviderAccountMetadataSchema.parse(providerAccount.metadata)
    );
    const stored = bvnkStoredSubmitRequirements(input.direction, stage);
    if (stored !== null) {
      requirements = stored;
    }
    gateOnCollectedFields = stage !== null && stage.kind !== "agreements_pending";
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

  if (gateOnCollectedFields && isCollectFieldsRequirements(requirements)) {
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
