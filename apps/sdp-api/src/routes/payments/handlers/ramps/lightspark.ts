import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  buildLightsparkAccountInfo,
  buildLightsparkBusinessInfo,
  buildLightsparkIndividualInfo,
} from "@sdp/payments/ramps/providers/lightspark/counterparty";
import {
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
import {
  type CounterpartyProviderAccountRow,
  createPostgresCounterpartyProviderAccountsRepository,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest, internalError } from "@/lib/errors";
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
 * Resolves the Grid external payout account for one fiat/country corridor.
 */
export async function ensureLightsparkPayoutAccount(
  c: AppContext,
  input: PayoutAccountContext & { collectedData?: CollectedFieldData }
): Promise<CounterpartyProviderAccountRow> {
  if (input.collectedData === undefined) {
    throw badRequest("collectedData with destinationCountry is required for Lightspark off-ramp.");
  }
  const destinationCountry = requireDestinationCountry(input.collectedData);
  const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const existing = await repository.getActiveExternalAccount({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "lightspark",
    fiatCurrency: input.fiatCurrency,
    destinationCountry,
  });
  const pending =
    existing === null
      ? await repository.insertPendingExternalAccount({
          organizationId: input.counterparty.organization_id,
          projectId: input.projectId,
          counterpartyId: input.counterparty.id,
          provider: "lightspark",
          providerCustomerReference: input.customer.customerId,
          fiatCurrency: input.fiatCurrency,
          destinationCountry,
        })
      : existing;
  if (pending.external_account_reference !== null) {
    return pending;
  }
  const accountInfo = buildLightsparkAccountInfo(
    input.counterparty,
    input.cryptoRail,
    input.fiatCurrency,
    input.collectedData
  );
  const created = await RAMP_PROVIDER_CLIENTS.lightspark.getOrCreateFiatExternalAccount(
    rampRuntime(c),
    {
      customerId: input.customer.customerId,
      currency: input.fiatCurrency,
      platformAccountId: pending.id,
      accountInfo,
    }
  );
  const completed = await repository.completeExternalAccount({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "lightspark",
    id: pending.id,
    externalAccountReference: created.id,
    providerStatus: created.status,
  });
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
