import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  buildLightsparkAccountInfo,
  buildLightsparkBusinessInfo,
  buildLightsparkIndividualInfo,
} from "@sdp/payments/ramps/providers/lightspark/counterparty";
import {
  isLightsparkExternalAccountActive,
  isLightsparkPurposeOfPayment,
  LIGHTSPARK_PURPOSE_OF_PAYMENT_LABELS,
  type LightsparkPurposeOfPayment,
  readLightsparkData,
  readLightsparkPurposeOfPayment,
} from "@sdp/payments/ramps/providers/lightspark/provider-data";
import type { LightsparkCustomerResolution } from "@sdp/payments/ramps/types";
import { type CountryCode, isCountryCode } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  type CounterpartyProviderAccountRow,
  createPostgresCounterpartyProviderAccountsRepository,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import {
  badRequest,
  conflict,
  counterpartyExternalAccountAmbiguous,
  internalError,
} from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { logEvent } from "@/runtime/money-path-events";
import { type AppContext, rampRuntime } from "../../context";

/**
 * Merges a Lightspark provider-data patch under the counterparty row lock.
 *
 * @param c - Request context for database access.
 * @param row - Counterparty whose provider data is updated.
 * @param projectId - Project that owns the counterparty.
 * @param patch - Lightspark data to merge.
 * @returns Nothing.
 */
async function persistLightsparkData(
  c: AppContext,
  row: CounterpartyRow,
  projectId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
  await repo.mutateProviderData({
    counterpartyId: row.id,
    organizationId: row.organization_id,
    projectId,
    mutate(providerData) {
      return {
        ...providerData,
        lightspark: { ...readLightsparkData(providerData), ...patch },
      };
    },
  });
}

/**
 * Reads the linked Grid customer id from counterparty_provider_accounts.
 *
 * @param c - Request context for database access.
 * @param counterparty - Counterparty whose Lightspark customer link is read.
 * @param projectId - Project that owns the counterparty.
 * @returns The linked Grid customer id, or null when none is linked.
 */
export async function lightsparkProviderCustomerId(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string
): Promise<string | null> {
  const link = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
  ).getProviderAccount({
    organizationId: counterparty.organization_id,
    projectId,
    counterpartyId: counterparty.id,
    provider: "lightspark",
  });
  return link === null ? null : link.provider_customer_reference;
}

/**
 * Returns the linked Grid customer, creating it just-in-time from transient
 * collected identity fields when no link exists. Creation is idempotent on the
 * counterparty id (Grid platformCustomerId), and the resulting reference is
 * linked in counterparty_provider_accounts.
 *
 * @param c - Request context for provider and database access.
 * @param input - Parent counterparty, project scope, and transient identity fields.
 * @returns The Lightspark customer resolution.
 */
export async function ensureLightsparkCustomer(
  c: AppContext,
  input: { counterparty: CounterpartyRow; projectId: string; collectedData?: CollectedFieldData }
): Promise<LightsparkCustomerResolution> {
  const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const existing = await repository.getProviderAccount({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "lightspark",
  });
  if (existing) {
    return { customerId: existing.provider_customer_reference };
  }

  const customer = await RAMP_PROVIDER_CLIENTS.lightspark.getOrCreateCustomer(
    rampRuntime(c),
    input.counterparty.entity_type === "individual"
      ? {
          platformCustomerId: input.counterparty.id,
          customerType: "INDIVIDUAL",
          individualInfo: buildLightsparkIndividualInfo(input.collectedData),
        }
      : {
          platformCustomerId: input.counterparty.id,
          customerType: "BUSINESS",
          businessInfo: buildLightsparkBusinessInfo(input.collectedData),
        }
  );
  await repository.upsertProviderAccount({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "lightspark",
    providerCustomerReference: customer.id,
  });
  logEvent("info", {
    event: "sdp_api_lightspark_customer_created",
    organization_id: input.counterparty.organization_id,
    project_id: input.projectId,
    counterparty_id: input.counterparty.id,
    provider_customer_reference: customer.id,
  });
  return { customerId: customer.id };
}

/**
 * Returns the counterparty's purpose-of-payment, persisting a newly collected
 * value into provider_data first. The stored code is required on every Grid
 * quote because some payout corridors mandate it.
 *
 * @param c - Request context for database access.
 * @param input - Parent counterparty, project scope, and transient collected fields.
 * @returns The stored purpose-of-payment, or null when none has been collected.
 */
export async function ensureLightsparkPurposeOfPayment(
  c: AppContext,
  input: { counterparty: CounterpartyRow; projectId: string; collectedData?: CollectedFieldData }
): Promise<LightsparkPurposeOfPayment | null> {
  const supplied =
    input.collectedData === undefined ? undefined : input.collectedData.purposeOfPayment;
  if (supplied === undefined) {
    return readLightsparkPurposeOfPayment(input.counterparty.provider_data);
  }
  if (!isLightsparkPurposeOfPayment(supplied)) {
    throw badRequest(
      `purposeOfPayment must be one of: ${Object.keys(LIGHTSPARK_PURPOSE_OF_PAYMENT_LABELS).join(", ")}`
    );
  }
  await persistLightsparkData(c, input.counterparty, input.projectId, {
    purposeOfPayment: supplied,
  });
  return supplied;
}

interface PayoutAccountContext {
  counterparty: CounterpartyRow;
  projectId: string;
  customer: LightsparkCustomerResolution;
  cryptoRail: CryptoRailId;
  fiatCurrency: RampFiatCurrency;
}

/**
 * Selects the reusable Lightspark payout account for a corridor when no
 * explicit account was chosen.
 *
 * @param accounts - Active external accounts for one payout corridor.
 * @param fiatCurrency - Fiat currency of the payout corridor.
 * @param destinationCountry - Destination country of the payout corridor.
 * @returns The single reusable account, or null when the corridor has none.
 */
export function selectLightsparkPayoutAccount(
  accounts: readonly CounterpartyProviderAccountRow[],
  fiatCurrency: string,
  destinationCountry: CountryCode
): CounterpartyProviderAccountRow | null {
  if (accounts.length === 0) {
    return null;
  }
  if (accounts.length === 1) {
    return accounts[0];
  }
  throw counterpartyExternalAccountAmbiguous("lightspark", fiatCurrency, destinationCountry);
}

/**
 * Loads an explicitly selected Lightspark payout account and verifies it is
 * an active, provider-verified account for the requested corridor.
 *
 * @param c - Request context for database access.
 * @param input - Tenant scope, corridor, and the selected provider account id.
 * @returns The validated payout account row.
 */
export async function requireLightsparkPayoutAccountById(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string;
    counterpartyId: string;
    providerAccountId: string;
    fiatCurrency: RampFiatCurrency;
    destinationCountry: CountryCode;
  }
): Promise<CounterpartyProviderAccountRow> {
  const selected = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
  ).getExternalAccountById({
    organizationId: input.organizationId,
    projectId: input.projectId,
    counterpartyId: input.counterpartyId,
    provider: "lightspark",
    id: input.providerAccountId,
  });
  if (
    selected === null ||
    selected.status !== "active" ||
    selected.fiat_currency !== input.fiatCurrency ||
    selected.destination_country !== input.destinationCountry ||
    selected.external_account_reference === null ||
    selected.provider_status === null ||
    !isLightsparkExternalAccountActive(selected.provider_status)
  ) {
    throw badRequest(
      "providerAccountId does not reference an active lightspark payout account for this corridor."
    );
  }
  return selected;
}

/**
 * Resolves the collected destination country into the canonical country type.
 *
 * @param collectedData - Collected Lightspark payout fields.
 * @returns The validated destination country.
 */
function requireDestinationCountry(collectedData: CollectedFieldData): CountryCode {
  const destinationCountry = collectedData.destinationCountry;
  if (destinationCountry === undefined || !isCountryCode(destinationCountry)) {
    throw badRequest("destinationCountry must be a supported ISO 3166-1 alpha-2 country code.");
  }
  return destinationCountry;
}

/**
 * Creates the Grid external payout account a new-account submission defines,
 * always under a freshly minted platform identity. Completed accounts are never
 * adopted — reusing one is an explicit `providerAccountId` selection, not a
 * side effect of submitting fields.
 *
 * @param c - Request context for database and provider access.
 * @param input - Counterparty, project, customer, crypto rail, fiat currency, and collected payout data.
 * @returns The newly completed Lightspark external account row.
 */
export async function ensureLightsparkPayoutAccount(
  c: AppContext,
  input: PayoutAccountContext & { collectedData?: CollectedFieldData }
): Promise<CounterpartyProviderAccountRow> {
  if (input.collectedData === undefined) {
    throw badRequest("collectedData with destinationCountry is required for Lightspark off-ramp.");
  }
  const destinationCountry = requireDestinationCountry(input.collectedData);
  const paymentRail: string | undefined = input.collectedData.paymentRails;
  if (paymentRail === undefined) {
    throw badRequest('Missing required field "paymentRails" for Lightspark off-ramp.');
  }
  // Validate the submitted bank fields before touching the database: a rejected
  // submission must not leave a durable pending account row behind.
  const accountInfo = buildLightsparkAccountInfo(
    input.counterparty,
    input.cryptoRail,
    input.fiatCurrency,
    input.collectedData
  );
  const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  // Every submission mints a fresh pending identity — a stale same-rail pending
  // row is never resumed. The provider converges on platformAccountId, so
  // reusing a prior row's id could silently bind this submission to an account
  // created from DIFFERENT bank details, and bank details are never persisted
  // (store-nothing PII), so sameness cannot be proven. The partial unique index
  // allows one live reservation per corridor and rail: a concurrent submission
  // gets a 409 while another is genuinely in flight — never an archive of the
  // other request's parent row, which would strand its provider account. On
  // failure the request archives its OWN reservation so an immediate retry is
  // clean; only a process crash leaves a reservation behind (409 until swept).
  let pending: CounterpartyProviderAccountRow;
  try {
    pending = await repository.insertPendingExternalAccount({
      organizationId: input.counterparty.organization_id,
      projectId: input.projectId,
      counterpartyId: input.counterparty.id,
      provider: "lightspark",
      providerCustomerReference: input.customer.customerId,
      fiatCurrency: input.fiatCurrency,
      destinationCountry,
      paymentRail,
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw conflict(
        "A payout account submission for this corridor is already in progress. Retry once it settles."
      );
    }
    throw error;
  }
  let completed: CounterpartyProviderAccountRow | null;
  try {
    const created = await RAMP_PROVIDER_CLIENTS.lightspark.getOrCreateFiatExternalAccount(
      rampRuntime(c),
      {
        customerId: input.customer.customerId,
        currency: input.fiatCurrency,
        platformAccountId: pending.id,
        accountInfo,
      }
    );
    completed = await repository.completeExternalAccount({
      organizationId: input.counterparty.organization_id,
      projectId: input.projectId,
      counterpartyId: input.counterparty.id,
      provider: "lightspark",
      id: pending.id,
      externalAccountReference: created.id,
      providerStatus: created.status,
    });
  } catch (error) {
    try {
      await repository.archiveExternalAccount({
        organizationId: input.counterparty.organization_id,
        projectId: input.projectId,
        counterpartyId: input.counterparty.id,
        provider: "lightspark",
        id: pending.id,
      });
    } catch (compensationError) {
      logEvent("warn", {
        event: "sdp_api_lightspark_reservation_compensation_failed",
        organization_id: input.counterparty.organization_id,
        project_id: input.projectId,
        counterparty_id: input.counterparty.id,
        provider_account_id: pending.id,
        error: compensationError instanceof Error ? compensationError.message : "unknown",
      });
    }
    throw error;
  }
  if (completed === null) {
    throw internalError("Lightspark external-account completion lost its parent scope.");
  }
  logEvent("info", {
    event: "sdp_api_lightspark_external_account_completed",
    organization_id: input.counterparty.organization_id,
    project_id: input.projectId,
    counterparty_id: input.counterparty.id,
    provider_account_id: completed.id,
    external_account_reference: completed.external_account_reference,
    provider_status: completed.provider_status,
    fiat_currency: completed.fiat_currency,
    destination_country: completed.destination_country,
  });
  return completed;
}
