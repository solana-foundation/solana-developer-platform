import type { BvnkPaymentRampInstruction, PaymentRampQuote } from "@sdp/types";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest, internalError } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  type BvnkCustomerResolution,
  type BvnkOnrampEntry,
  type BvnkOnrampRequestSpec,
  type BvnkPaymentRuleResolution,
  buildBvnkOnrampInstruction,
  buildBvnkRuleEntity,
  bvnkCustomerExternalReference,
  bvnkOnrampKey,
  bvnkRuleReference,
  bvnkUnverifiedOnboardingStatus,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  normalizeBvnkCurrencyAndNetwork,
  readBvnkCustomer,
  readBvnkData,
  readBvnkOnrampEntry,
  readBvnkWallets,
} from "@/lib/ramps/providers/bvnk";
import type { RampRuntimeContext } from "@/lib/ramps/types";
import { buildBvnkIndividualPayload } from "@/lib/ramps/validation/bvnk";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { type AppContext, rampRuntime, resolveSdpEnvironment } from "../../context";

type BvnkOnrampQuote = PaymentRampQuote & {
  provider: "bvnk";
  deliveryMode: "manual_instructions";
  paymentInstructions: BvnkPaymentRampInstruction[];
};

export interface BvnkOnrampQuoteResult {
  quote: BvnkOnrampQuote;
  persist: boolean;
}

function requesterIpAddress(c: AppContext): string {
  const forwarded = c.req.header("x-forwarded-for");
  return c.req.header("cf-connecting-ip") ?? forwarded?.split(",")[0]?.trim() ?? "0.0.0.0";
}

/** Merges customer + wallet entry state into counterparty.provider_data.bvnk. */
async function persistBvnkCustomerState(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  customer: BvnkCustomerResolution
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
  const bvnk = readBvnkData(counterparty.provider_data);
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    providerData: {
      ...counterparty.provider_data,
      bvnk: {
        ...bvnk,
        customer: { ...readBvnkCustomer(counterparty.provider_data), ...customer },
      },
    },
  });
}

async function persistBvnkOnrampState(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  key: string,
  customer: BvnkCustomerResolution,
  entry: BvnkOnrampEntry
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
  const bvnk = readBvnkData(counterparty.provider_data);
  const wallets = readBvnkWallets(counterparty.provider_data);
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    providerData: {
      ...counterparty.provider_data,
      bvnk: {
        ...bvnk,
        customer: { ...readBvnkCustomer(counterparty.provider_data), ...customer },
        wallets: { ...wallets, [key]: { ...wallets[key], ...entry } },
      },
    },
  });
}

/**
 * Ensures the counterparty has a BVNK customer (agreement → sign → create) and
 * refreshes verification status when pending. Persists customer state to
 * counterparty.provider_data.bvnk.customer after each completed step.
 */
export async function ensureBvnkCustomer(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  params: {
    fiatCurrency: string;
    collectedData?: CollectedFieldData;
  }
): Promise<BvnkCustomerResolution> {
  if (counterparty.entity_type === "business") {
    throw badRequest("BVNK supports individual counterparties only.");
  }
  const countryCode = counterparty.identity.address?.countryCode;
  if (!countryCode) {
    throw badRequest("Counterparty address country is required for BVNK.");
  }

  const ctx = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.bvnk;

  let customer = readBvnkCustomer(counterparty.provider_data);

  if (!customer.customerReference) {
    const individual = buildBvnkIndividualPayload(
      counterparty,
      params.collectedData,
      params.fiatCurrency
    );
    const session = await client.createAgreementSession(ctx, {
      customerType: "INDIVIDUAL",
      countryCode,
      useCase: "EMBEDDED_FIAT_ACCOUNTS",
    });
    await client.signAgreement(ctx, {
      reference: session.reference,
      ipAddress: requesterIpAddress(c),
    });
    const externalReference =
      customer.externalReference ?? bvnkCustomerExternalReference(counterparty.id);
    const created = await client.createBvnkCustomer(ctx, {
      externalReference,
      signedAgreementSessionReference: session.reference,
      individual,
    });
    customer = {
      externalReference,
      customerReference: created.reference,
      status: created.status,
      verificationStatus: created.verificationStatus,
      verificationUrl: created.verificationUrl,
    };
    await persistBvnkCustomerState(c, counterparty, projectId, customer);
  }

  if (customer.customerReference && !isBvnkCustomerVerified(customer.status)) {
    const latest = await client.getBvnkCustomer(ctx, { reference: customer.customerReference });
    customer = {
      ...customer,
      status: latest.status,
      verificationStatus: latest.verificationStatus,
      verificationUrl: latest.verificationUrl ?? customer.verificationUrl,
    };
    await persistBvnkCustomerState(c, counterparty, projectId, customer);
  }

  return customer;
}

/**
 * Advances on-ramp provisioning (wallet profile → create/get wallet → create
 * rule) for a verified customer + funding spec. Persists entry state to
 * counterparty.provider_data.bvnk.wallets[key] after each completed step.
 */
export async function ensureBvnkPaymentRule(
  c: AppContext,
  ctx: RampRuntimeContext,
  counterparty: CounterpartyRow,
  projectId: string,
  customer: BvnkCustomerResolution,
  params: BvnkOnrampRequestSpec
): Promise<BvnkPaymentRuleResolution> {
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const key = bvnkOnrampKey(
    params.fiatCurrency,
    params.currency,
    params.network,
    params.destinationWalletAddress
  );

  let entry: BvnkOnrampEntry = readBvnkOnrampEntry(counterparty.provider_data, key);

  if (entry.walletId && entry.bankAccount?.accountNumber && entry.ruleId) {
    return { customer, entry, onboardingStatus: "ready" };
  }

  if (!entry.request) {
    entry = { ...entry, request: params };
    await persistBvnkOnrampState(c, counterparty, projectId, key, customer, entry);
  }

  if (!isBvnkCustomerVerified(customer.status) || !customer.customerReference) {
    return {
      customer,
      entry,
      onboardingStatus: bvnkUnverifiedOnboardingStatus(customer.status),
    };
  }

  if (entry.provisioningError) {
    entry = { ...entry, provisioningError: undefined };
  }

  if (!entry.walletId) {
    const walletProfile = await client.getFiatWalletProfile(ctx, {
      customerReference: customer.customerReference,
      currency: params.fiatCurrency,
    });
    const wallet = await client.createFiatWallet(ctx, {
      customerReference: customer.customerReference,
      name: `SDP onramp ${customer.externalReference}`,
      currencyCode: params.fiatCurrency,
      walletProfile,
      idempotencyKey: (await hashString(`bvnk-wallet:${counterparty.id}:${key}`)).slice(0, 36),
    });
    entry = {
      ...entry,
      walletId: wallet.id,
      walletStatus: wallet.status,
      bankAccount: wallet.bankAccount,
    };
    await persistBvnkOnrampState(c, counterparty, projectId, key, customer, entry);
  }

  if (entry.walletId && !isBvnkWalletActive(entry.walletStatus)) {
    try {
      const wallet = await client.getFiatWallet(ctx, { walletId: entry.walletId });
      entry = {
        ...entry,
        walletStatus: wallet.status ?? entry.walletStatus,
        bankAccount: wallet.bankAccount ?? entry.bankAccount,
      };
      await persistBvnkOnrampState(c, counterparty, projectId, key, customer, entry);
    } catch (error) {
      console.warn(
        `[bvnk onramp] wallet ${entry.walletId} status refresh failed; relying on webhook: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!entry.ruleId && entry.walletId && isBvnkWalletActive(entry.walletStatus)) {
    const rule = await client.createOnrampRule(ctx, {
      reference: await bvnkRuleReference(counterparty.id, key),
      walletId: entry.walletId,
      currency: params.currency,
      network: params.network,
      beneficiaryAddress: params.destinationWalletAddress,
      entity: {
        ...buildBvnkRuleEntity(counterparty),
        customerIdentifier: customer.customerReference,
      },
    });
    entry = { ...entry, ruleId: rule.id ?? entry.ruleId, ruleStatus: rule.status };
    await persistBvnkOnrampState(c, counterparty, projectId, key, customer, entry);
  }

  return {
    customer,
    entry,
    onboardingStatus: entry.ruleId && entry.bankAccount?.accountNumber ? "ready" : "provisioning",
  };
}

async function resolveBvnkOnramp(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    cryptoToken: string;
    fiatCurrency?: string;
    destinationWalletAddress: string;
    collectedData?: CollectedFieldData;
  }
) {
  if (!input.fiatCurrency) {
    throw badRequest("fiatCurrency is required for BVNK on-ramp.");
  }
  const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
  const fiatCurrency = input.fiatCurrency;
  const customer = await ensureBvnkCustomer(c, input.counterparty, input.projectId, {
    fiatCurrency,
    collectedData: input.collectedData,
  });
  const resolution = await ensureBvnkPaymentRule(
    c,
    rampRuntime(c),
    input.counterparty,
    input.projectId,
    customer,
    {
      currency,
      network,
      destinationWalletAddress: input.destinationWalletAddress,
      fiatCurrency,
    }
  );
  const instruction = buildBvnkOnrampInstruction(resolution, {
    network,
    destinationWalletAddress: input.destinationWalletAddress,
    fiatCurrency,
    mode: resolveSdpEnvironment(c),
  });
  const reference =
    resolution.onboardingStatus === "ready"
      ? resolution.entry.ruleId
      : resolution.customer.customerReference;
  if (!reference) {
    throw internalError(
      `BVNK on-ramp missing reference at status "${resolution.onboardingStatus}".`
    );
  }
  return { instruction, id: reference, reference };
}

/**
 * Builds a BVNK on-ramp quote. Only "ready" onboarding states are committable
 * as a transfer row — mid-onboarding quotes must not be persisted.
 */
export async function bvnkOnrampQuote(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    cryptoToken: string;
    fiatCurrency?: string;
    destinationWalletAddress: string;
    collectedData?: CollectedFieldData;
  }
): Promise<BvnkOnrampQuoteResult> {
  const { instruction, id } = await resolveBvnkOnramp(c, input);
  const quote: BvnkOnrampQuote = {
    provider: "bvnk",
    id,
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions: [instruction],
  };
  return { quote, persist: instruction.onboardingStatus === "ready" };
}
