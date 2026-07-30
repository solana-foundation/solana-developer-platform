import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { CreateLightsparkCustomerInput } from "@sdp/payments/ramps/providers/lightspark/client";
import {
  buildLightsparkAccountInfo,
  buildLightsparkBusinessInfo,
  lightsparkPayoutCollectedData,
} from "@sdp/payments/ramps/providers/lightspark/counterparty";
import {
  isLightsparkExternalAccountActive,
  type LightsparkPayoutAccount,
  type LightsparkPayoutAccountEntry,
  latestLightsparkPayoutAccount,
  lightsparkPayoutAccountKey,
  readLightsparkCustomerId,
  readLightsparkData,
  readLightsparkPayoutAccountByKey,
  readLightsparkPayoutAccounts,
} from "@sdp/payments/ramps/providers/lightspark/provider-data";
import type { LightsparkCustomerResolution } from "@sdp/payments/ramps/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest, notFound } from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
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
 * Returns the Grid customer id for a counterparty, lazily creating the native
 * Lightspark customer (via the provider) and persisting it into provider_data
 * on first use. Business counterparties require collected businessInfo fields
 * and KYB approval — the customer id is persisted only once verified, so a
 * pending verification re-runs on the next requirements advance (creation is
 * idempotent by platformCustomerId). Collected values flow to Grid only and
 * are never persisted.
 */
export async function ensureLightsparkCustomer(
  c: AppContext,
  {
    counterparty,
    projectId,
    collectedData,
  }: { counterparty: CounterpartyRow; projectId: string; collectedData?: CollectedFieldData }
): Promise<LightsparkCustomerResolution> {
  const existing = readLightsparkCustomerId(counterparty.provider_data);
  if (existing) {
    return { customerId: existing };
  }

  const input: CreateLightsparkCustomerInput =
    counterparty.entity_type === "business"
      ? {
          platformCustomerId: counterparty.id,
          customerType: "BUSINESS",
          businessInfo: buildLightsparkBusinessInfo(collectedData),
          email: counterparty.email,
        }
      : {
          platformCustomerId: counterparty.id,
          customerType: "INDIVIDUAL",
          fullName: counterparty.display_name,
          email: counterparty.email,
        };
  const customer = await RAMP_PROVIDER_CLIENTS.lightspark.getOrCreateCustomer(
    rampRuntime(c),
    input
  );
  if (input.customerType === "BUSINESS") {
    const verification = await RAMP_PROVIDER_CLIENTS.lightspark.submitVerification(rampRuntime(c), {
      customerId: customer.id,
    });
    if (verification.verificationStatus !== "APPROVED") {
      const outstanding = verification.errors.map((error) => error.reason).join("; ");
      throw badRequest(
        `Lightspark KYB verification is ${verification.verificationStatus}. Outstanding requirements: ${outstanding}`
      );
    }
  }

  const row = await freshCounterpartyRow(c, counterparty, projectId);
  await persistLightsparkData(c, row, projectId, { customerId: customer.id });

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
