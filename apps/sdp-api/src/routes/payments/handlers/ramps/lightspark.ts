import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  buildLightsparkAccountInfo,
  buildLightsparkBusinessInfo,
  buildLightsparkIndividualInfo,
  lightsparkPayoutCollectedData,
} from "@sdp/payments/ramps/providers/lightspark/counterparty";
import {
  isLightsparkExternalAccountActive,
  type LightsparkPayoutAccount,
  type LightsparkPayoutAccountEntry,
  latestLightsparkPayoutAccount,
  lightsparkPayoutAccountKey,
  readLightsparkData,
  readLightsparkPayoutAccountByKey,
  readLightsparkPayoutAccounts,
} from "@sdp/payments/ramps/providers/lightspark/provider-data";
import type { LightsparkCustomerResolution } from "@sdp/payments/ramps/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest, notFound } from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { logEvent } from "@/runtime/money-path-events";
import { type AppContext, rampRuntime } from "../../context";

/**
 * Re-reads the counterparty row so provider_data merges happen against the
 * latest state instead of the request's snapshot — concurrent requests for the
 * same counterparty would otherwise clobber each other's writes.
 */
async function freshCounterpartyRow(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string
): Promise<CounterpartyRow> {
  const row = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
  });
  if (!row) {
    throw notFound("Counterparty");
  }
  return row;
}

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

async function persistLightsparkPayoutAccount(
  c: AppContext,
  row: CounterpartyRow,
  projectId: string,
  customerId: string,
  entry: LightsparkPayoutAccountEntry
): Promise<void> {
  await persistLightsparkData(c, row, projectId, {
    customerId,
    payoutAccounts: {
      ...readLightsparkPayoutAccounts(row.provider_data),
      [entry.key]: { accountId: entry.accountId, status: entry.status, createdAt: entry.createdAt },
    },
  });
}

interface PayoutAccountContext {
  counterparty: CounterpartyRow;
  projectId: string;
  customer: LightsparkCustomerResolution;
  fiatCurrency: RampFiatCurrency;
}

async function refreshPayoutAccount(
  c: AppContext,
  input: PayoutAccountContext,
  entry: LightsparkPayoutAccountEntry
): Promise<LightsparkPayoutAccount> {
  if (isLightsparkExternalAccountActive(entry.status)) {
    return entry;
  }

  const latest = await RAMP_PROVIDER_CLIENTS.lightspark.getExternalAccount(rampRuntime(c), {
    accountId: entry.accountId,
  });
  const refreshed: LightsparkPayoutAccountEntry = { ...entry, status: latest.status };
  if (latest.status !== entry.status) {
    const row = await freshCounterpartyRow(c, input.counterparty, input.projectId);
    await persistLightsparkPayoutAccount(
      c,
      row,
      input.projectId,
      input.customer.customerId,
      refreshed
    );
  }
  if (!isLightsparkExternalAccountActive(latest.status)) {
    throw badRequest(
      `Lightspark payout account is not active yet (status: ${latest.status}). Retry once it is verified.`
    );
  }
  return refreshed;
}

/**
 * Resolves the Grid external payout account for the quote. Entries are cached
 * in provider_data keyed by `${fiat}:${hash(collectedData)}`, so re-submitting
 * the same bank details reuses the same Grid account while different details
 * create (and keep) a distinct one — Grid customers can hold several external
 * accounts. Raw bank details pass through to Grid and are never stored. A
 * quote without collected details uses the most recently created account for
 * the currency.
 */
export async function ensureLightsparkPayoutAccount(
  c: AppContext,
  input: PayoutAccountContext & { collectedData?: CollectedFieldData }
): Promise<LightsparkPayoutAccount> {
  const collected =
    input.collectedData === undefined
      ? undefined
      : lightsparkPayoutCollectedData(input.fiatCurrency, input.collectedData);

  if (!collected) {
    let entry = latestLightsparkPayoutAccount(input.counterparty.provider_data, input.fiatCurrency);
    if (!entry) {
      const row = await freshCounterpartyRow(c, input.counterparty, input.projectId);
      entry = latestLightsparkPayoutAccount(row.provider_data, input.fiatCurrency);
    }
    if (!entry) {
      throw badRequest(
        "collectedData with payout bank details is required for Lightspark off-ramp."
      );
    }
    return refreshPayoutAccount(c, input, entry);
  }

  const key = await lightsparkPayoutAccountKey(input.fiatCurrency, collected);
  let entry = readLightsparkPayoutAccountByKey(input.counterparty.provider_data, key);
  if (!entry) {
    const row = await freshCounterpartyRow(c, input.counterparty, input.projectId);
    entry = readLightsparkPayoutAccountByKey(row.provider_data, key);

    if (!entry) {
      const accountInfo = buildLightsparkAccountInfo(row, input.fiatCurrency, collected);
      const created = await RAMP_PROVIDER_CLIENTS.lightspark.getOrCreateFiatExternalAccount(
        rampRuntime(c),
        {
          customerId: input.customer.customerId,
          currency: input.fiatCurrency,
          platformAccountId: `${input.counterparty.id}:${key}`,
          accountInfo,
        }
      );

      const account: LightsparkPayoutAccountEntry = {
        key,
        accountId: created.id,
        status: created.status,
        createdAt: new Date().toISOString(),
      };
      const latestRow = await freshCounterpartyRow(c, input.counterparty, input.projectId);
      await persistLightsparkPayoutAccount(
        c,
        latestRow,
        input.projectId,
        input.customer.customerId,
        account
      );
      if (!isLightsparkExternalAccountActive(created.status)) {
        throw badRequest(
          `Lightspark payout account was created but is not active yet (status: ${created.status}). Retry once it is verified.`
        );
      }
      return account;
    }
  }

  return refreshPayoutAccount(c, input, entry);
}
