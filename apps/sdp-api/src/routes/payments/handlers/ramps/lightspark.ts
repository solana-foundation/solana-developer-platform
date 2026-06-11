import type { PaymentRampQuote } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest } from "@/lib/errors";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  isLightsparkExternalAccountActive,
  type LightsparkPayoutAccount,
  readLightsparkCustomerId,
  readLightsparkData,
  readLightsparkPayoutAccount,
  readLightsparkPayoutAccounts,
} from "@/lib/ramps/providers/lightspark";
import type { LightsparkCustomerResolution } from "@/lib/ramps/types";
import { buildLightsparkAccountInfo } from "@/lib/ramps/validation/lightspark";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { type AppContext, rampRuntime } from "../../context";

async function persistLightsparkData(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    providerData: {
      ...counterparty.provider_data,
      lightspark: { ...readLightsparkData(counterparty.provider_data), ...patch },
    },
  });
}

/**
 * Returns the Grid customer id for a counterparty, lazily creating the native
 * Lightspark customer (via the provider) and persisting it into provider_data
 * on first use.
 */
export async function ensureLightsparkCustomer(
  c: AppContext,
  { counterparty, projectId }: { counterparty: CounterpartyRow; projectId: string }
): Promise<LightsparkCustomerResolution> {
  const existing = readLightsparkCustomerId(counterparty.provider_data);
  if (existing) {
    return { customerId: existing };
  }

  const customer = await RAMP_PROVIDER_CLIENTS.lightspark.getOrCreateCustomer(rampRuntime(c), {
    platformCustomerId: counterparty.id,
    customerType: counterparty.entity_type === "business" ? "BUSINESS" : "INDIVIDUAL",
    fullName: counterparty.display_name,
    email: counterparty.email,
  });

  await persistLightsparkData(c, counterparty, projectId, { customerId: customer.id });

  return { customerId: customer.id };
}

async function persistLightsparkPayoutAccount(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  customerId: string,
  fiatCurrency: RampFiatCurrency,
  account: LightsparkPayoutAccount
): Promise<void> {
  await persistLightsparkData(c, counterparty, projectId, {
    customerId,
    payoutAccounts: {
      ...readLightsparkPayoutAccounts(counterparty.provider_data),
      [fiatCurrency]: account,
    },
  });
}

/**
 * Resolves the Grid external payout account for (counterparty, fiatCurrency).
 * Creates it from collected bank details on first use, persisting only the
 * resulting account id + status into provider_data — raw bank details are
 * passed through to Grid and never stored.
 */
export async function ensureLightsparkPayoutAccount(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    customer: LightsparkCustomerResolution;
    fiatCurrency: RampFiatCurrency;
    collectedData?: CollectedFieldData;
  }
): Promise<LightsparkPayoutAccount> {
  const client = RAMP_PROVIDER_CLIENTS.lightspark;
  const stored = readLightsparkPayoutAccount(input.counterparty.provider_data, input.fiatCurrency);

  if (stored) {
    if (isLightsparkExternalAccountActive(stored.status)) {
      return stored;
    }
    const latest = await client.getExternalAccount(rampRuntime(c), {
      accountId: stored.accountId,
    });
    const refreshed: LightsparkPayoutAccount = { accountId: latest.id, status: latest.status };
    if (latest.status !== stored.status) {
      await persistLightsparkPayoutAccount(
        c,
        input.counterparty,
        input.projectId,
        input.customer.customerId,
        input.fiatCurrency,
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

  const accountInfo = buildLightsparkAccountInfo(
    input.counterparty,
    input.fiatCurrency,
    input.collectedData
  );
  const created = await client.createFiatExternalAccount(rampRuntime(c), {
    customerId: input.customer.customerId,
    currency: input.fiatCurrency,
    accountInfo,
  });
  const account: LightsparkPayoutAccount = { accountId: created.id, status: created.status };
  await persistLightsparkPayoutAccount(
    c,
    input.counterparty,
    input.projectId,
    input.customer.customerId,
    input.fiatCurrency,
    account
  );
  if (!isLightsparkExternalAccountActive(created.status)) {
    throw badRequest(
      `Lightspark payout account was created but is not active yet (status: ${created.status}). Retry once it is verified.`
    );
  }
  return account;
}

export async function lightsparkOfframpQuote(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    cryptoToken: string;
    fiatCurrency?: RampFiatCurrency;
    cryptoAmount: string;
    sourceWalletAddress: string;
    collectedData?: CollectedFieldData;
  }
): Promise<PaymentRampQuote> {
  if (!input.fiatCurrency) {
    throw badRequest("fiatCurrency is required for Lightspark off-ramp.");
  }

  const customer = await ensureLightsparkCustomer(c, {
    counterparty: input.counterparty,
    projectId: input.projectId,
  });
  const payoutAccount = await ensureLightsparkPayoutAccount(c, {
    counterparty: input.counterparty,
    projectId: input.projectId,
    customer,
    fiatCurrency: input.fiatCurrency,
    collectedData: input.collectedData,
  });

  return RAMP_PROVIDER_CLIENTS.lightspark.createOfframpQuote(rampRuntime(c), {
    cryptoToken: input.cryptoToken,
    fiatCurrency: input.fiatCurrency,
    cryptoAmount: input.cryptoAmount,
    sourceWalletAddress: input.sourceWalletAddress,
    externalCustomerId: input.counterparty.external_id ?? input.counterparty.id,
    customerId: customer.customerId,
    payoutAccountId: payoutAccount.accountId,
  });
}
