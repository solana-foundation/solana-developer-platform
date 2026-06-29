import type { BvnkPaymentRampInstruction, PaymentRampQuote } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { AppError, badRequest, counterpartyNotProvisioned, internalError } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  type BvnkCustomerResolution,
  type BvnkFiatWallet,
  type BvnkOfframpBeneficiary,
  type BvnkOfframpWallet,
  type BvnkOnrampPaymentRuleState,
  type BvnkOnrampRequestSpec,
  type BvnkPaymentRuleResolution,
  buildBvnkCustomerExternalReference,
  buildBvnkOfframpWalletName,
  buildBvnkOnrampInstruction,
  buildBvnkOnrampPaymentRuleKey,
  buildBvnkOnrampWalletName,
  buildBvnkRuleEntity,
  buildBvnkWalletIdempotencyKey,
  bvnkRuleReference,
  bvnkUnverifiedOnboardingStatus,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  normalizeBvnkCurrencyAndNetwork,
  readBvnkCustomer,
  readBvnkData,
  readBvnkOfframpBeneficiaries,
  readBvnkOfframpBeneficiaryByKey,
  readBvnkOfframpWallet,
  readBvnkOfframpWallets,
  readBvnkOnrampPaymentRuleState,
  readBvnkWallets,
} from "@/lib/ramps/providers/bvnk";
import { buildRequirementSchema } from "@/lib/ramps/requirements";
import { rampId } from "@/lib/ramps/shared";
import type { RampRuntimeContext } from "@/lib/ramps/types";
import {
  buildBvnkIndividualPayload,
  bvnkOfframpAccountType,
  bvnkOfframpFields,
  isBvnkOfframpCurrency,
} from "@/lib/ramps/validation/bvnk";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { type AppContext, rampRuntime, resolveSdpEnvironment } from "../../context";

type BvnkOnrampQuote = PaymentRampQuote & {
  provider: "bvnk";
  deliveryMode: "manual_instructions";
  paymentInstructions: BvnkPaymentRampInstruction[];
};

function requesterIpAddress(c: AppContext): string {
  const forwarded = c.req.header("x-forwarded-for");
  return c.req.header("cf-connecting-ip") ?? forwarded?.split(",")[0]?.trim() ?? "0.0.0.0";
}

async function persistBvnkOnrampState(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  key: string,
  customer: BvnkCustomerResolution,
  entry: BvnkOnrampPaymentRuleState
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

/** Persists a merchant-owned off-ramp wallet to provider_data.bvnk.offramp.wallets. */
async function persistBvnkOfframpWallet(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  fiatCurrency: string,
  wallet: BvnkFiatWallet
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
  const bvnk = readBvnkData(counterparty.provider_data);
  const offramp =
    bvnk.offramp && typeof bvnk.offramp === "object"
      ? (bvnk.offramp as Record<string, unknown>)
      : {};
  const wallets = readBvnkOfframpWallets(counterparty.provider_data);
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    providerData: {
      ...counterparty.provider_data,
      bvnk: {
        ...bvnk,
        offramp: {
          ...offramp,
          wallets: { ...wallets, [fiatCurrency]: { id: wallet.id, status: wallet.status } },
        },
      },
    },
  });
}

/**
 * Provisions (or reuses) a merchant-owned BVNK fiat wallet for an off-ramp,
 * keyed per fiat currency in provider_data.bvnk.offramp.wallets — instead of the
 * shared BVNK_WALLET_ID. No customer/KYC: the wallet is owned by the merchant.
 *
 * A freshly-created wallet is not immediately ACTIVE; when a stored wallet is
 * still inactive its status is refreshed from BVNK so the requirements flow can
 * keep returning `funding_account_provisioning` until BVNK activates it.
 */
export async function ensureBvnkOfframpWallet(
  c: AppContext,
  ctx: RampRuntimeContext,
  counterparty: CounterpartyRow,
  projectId: string,
  fiatCurrency: RampFiatCurrency
): Promise<BvnkOfframpWallet> {
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const existing = readBvnkOfframpWallet(counterparty.provider_data, fiatCurrency);
  if (existing?.id) {
    if (isBvnkWalletActive(existing.status)) {
      return existing;
    }
    const refreshed = await client.getFiatWallet(ctx, { walletId: existing.id });
    if (refreshed.status !== existing.status) {
      await persistBvnkOfframpWallet(c, counterparty, projectId, fiatCurrency, refreshed);
    }
    return { id: refreshed.id, status: refreshed.status };
  }
  const walletProfile = await client.getFiatWalletProfile(ctx, { currency: fiatCurrency });
  const walletName = buildBvnkOfframpWalletName(fiatCurrency, counterparty.id);
  const wallet = await client.createFiatWallet(ctx, {
    name: walletName,
    currencyCode: fiatCurrency,
    walletProfile,
    idempotencyKey: await buildBvnkWalletIdempotencyKey(walletName),
  });
  await persistBvnkOfframpWallet(c, counterparty, projectId, fiatCurrency, wallet);
  return { id: wallet.id, status: wallet.status };
}

/** Persists an off-ramp payout beneficiary marker to provider_data.bvnk.offramp.beneficiaries. */
async function persistBvnkOfframpBeneficiary(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  beneficiary: BvnkOfframpBeneficiary
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
  const bvnk = readBvnkData(counterparty.provider_data);
  const offramp =
    bvnk.offramp && typeof bvnk.offramp === "object"
      ? (bvnk.offramp as Record<string, unknown>)
      : {};
  const beneficiaries = readBvnkOfframpBeneficiaries(counterparty.provider_data);
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    providerData: {
      ...counterparty.provider_data,
      bvnk: {
        ...bvnk,
        offramp: {
          ...offramp,
          beneficiaries: { ...beneficiaries, [beneficiary.key]: beneficiary },
        },
      },
    },
  });
}

async function bvnkOfframpBeneficiaryKey(
  fiatCurrency: string,
  collectedData: CollectedFieldData
): Promise<string> {
  const fields = Object.entries(collectedData)
    .map(([key, value]) => `${key}=${value.trim()}`)
    .sort()
    .join("&");
  return `${fiatCurrency}:${(await hashString(fields)).slice(0, 16)}`;
}

/**
 * Registers (or reuses) an off-ramp payout beneficiary from collected bank details,
 * keyed by `${fiat}:${hash(collected)}` so re-submitting the same details reuses the
 * record. PII-light: only a marker is persisted — the deferred payout (BVNK Step C)
 * forwards the raw bank details, which are validated here but not stored.
 */
export async function ensureBvnkOfframpBeneficiary(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    fiatCurrency: string;
    collectedData?: CollectedFieldData;
  }
): Promise<BvnkOfframpBeneficiary> {
  if (!isBvnkOfframpCurrency(input.fiatCurrency)) {
    throw badRequest(`BVNK off-ramp does not support payouts in ${input.fiatCurrency}.`);
  }
  const fiatCurrency = input.fiatCurrency;
  const collected =
    input.collectedData !== undefined && Object.keys(input.collectedData).length > 0
      ? input.collectedData
      : undefined;

  if (!collected) {
    const existing = latestBvnkOfframpBeneficiary(input.counterparty.provider_data, fiatCurrency);
    if (!existing) {
      throw badRequest("collectedData with payout bank details is required for BVNK off-ramp.");
    }
    return existing;
  }

  const parsed = buildRequirementSchema(bvnkOfframpFields(fiatCurrency)).safeParse(collected);
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Missing or invalid bank details for BVNK off-ramp.", {
      errors: z.treeifyError(parsed.error),
    });
  }

  const key = await bvnkOfframpBeneficiaryKey(fiatCurrency, collected);
  const existing = readBvnkOfframpBeneficiaryByKey(input.counterparty.provider_data, key);
  if (existing) {
    return existing;
  }

  const beneficiary: BvnkOfframpBeneficiary = {
    key,
    fiatCurrency,
    accountType: bvnkOfframpAccountType(fiatCurrency),
    createdAt: new Date().toISOString(),
  };
  await persistBvnkOfframpBeneficiary(c, input.counterparty, input.projectId, beneficiary);
  return beneficiary;
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
  const repo = getCounterpartiesRepository(c);

  let customer = readBvnkCustomer(counterparty.provider_data);
  const expectedExternalReference = buildBvnkCustomerExternalReference(counterparty.id);

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
    const created = await client.createBvnkCustomer(ctx, {
      externalReference: expectedExternalReference,
      signedAgreementSessionReference: session.reference,
      individual,
    });
    customer = {
      externalReference: expectedExternalReference,
      customerReference: created.reference,
      status: created.status,
      verificationStatus: created.verificationStatus,
      verificationUrl: created.verificationUrl,
    };
    await repo.upsertBvnkCustomerProviderData({
      counterpartyId: counterparty.id,
      organizationId: counterparty.organization_id,
      projectId,
      customer,
    });
  }

  if (customer.customerReference && !isBvnkCustomerVerified(customer.status)) {
    const latest = await client.getBvnkCustomer(ctx, { reference: customer.customerReference });
    customer = {
      ...customer,
      status: latest.status,
      verificationStatus: latest.verificationStatus,
      verificationUrl: latest.verificationUrl ?? customer.verificationUrl,
    };
    await repo.upsertBvnkCustomerProviderData({
      counterpartyId: counterparty.id,
      organizationId: counterparty.organization_id,
      projectId,
      customer,
    });
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
  const paymentRuleKey = buildBvnkOnrampPaymentRuleKey(
    params.fiatCurrency,
    params.currency,
    params.network,
    params.destinationWalletAddress
  );

  let entry: BvnkOnrampPaymentRuleState = readBvnkOnrampPaymentRuleState(
    counterparty.provider_data,
    paymentRuleKey
  );

  if (entry.walletId && entry.bankAccount?.accountNumber && entry.ruleId) {
    return { customer, entry, onboardingStatus: "ready" };
  }

  if (!entry.request) {
    entry = { ...entry, request: params };
    await persistBvnkOnrampState(c, counterparty, projectId, paymentRuleKey, customer, entry);
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
    const walletName = buildBvnkOnrampWalletName(counterparty.id, paymentRuleKey);
    const walletProfile = await client.getFiatWalletProfile(ctx, {
      customerReference: customer.customerReference,
      currency: params.fiatCurrency,
    });
    const wallet = await client.createFiatWallet(ctx, {
      customerReference: customer.customerReference,
      name: walletName,
      currencyCode: params.fiatCurrency,
      walletProfile,
      idempotencyKey: await buildBvnkWalletIdempotencyKey(walletName),
    });
    if (wallet.name !== walletName) {
      throw internalError(
        `BVNK returned unexpected on-ramp wallet name: ${wallet.name ?? "<missing>"}`
      );
    }
    entry = {
      ...entry,
      walletId: wallet.id,
      walletName: wallet.name,
      walletStatus: wallet.status,
      bankAccount: wallet.bankAccount,
    };
    await persistBvnkOnrampState(c, counterparty, projectId, paymentRuleKey, customer, entry);
  }

  if (entry.walletId && !isBvnkWalletActive(entry.walletStatus)) {
    try {
      const wallet = await client.getFiatWallet(ctx, { walletId: entry.walletId });
      entry = {
        ...entry,
        walletStatus: wallet.status ?? entry.walletStatus,
        bankAccount: wallet.bankAccount ?? entry.bankAccount,
      };
      await persistBvnkOnrampState(c, counterparty, projectId, paymentRuleKey, customer, entry);
    } catch (error) {
      console.warn(
        `[bvnk onramp] wallet ${entry.walletId} status refresh failed; relying on webhook: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!entry.ruleId && entry.walletId && isBvnkWalletActive(entry.walletStatus)) {
    const rule = await client.createOnrampRule(ctx, {
      reference: await bvnkRuleReference(counterparty.id, paymentRuleKey),
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
    await persistBvnkOnrampState(c, counterparty, projectId, paymentRuleKey, customer, entry);
  }

  return {
    customer,
    entry,
    onboardingStatus: entry.ruleId && entry.bankAccount?.accountNumber ? "ready" : "provisioning",
  };
}

export async function bvnkOnrampQuote(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    cryptoToken: string;
    fiatCurrency?: string;
    destinationWalletAddress: string;
  }
): Promise<BvnkOnrampQuote> {
  if (!input.fiatCurrency) {
    throw badRequest("fiatCurrency is required for BVNK on-ramp.");
  }
  const fiatCurrency = input.fiatCurrency;
  const providerData = input.counterparty.provider_data;
  const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
  const customer = readBvnkCustomer(providerData);
  const key = buildBvnkOnrampPaymentRuleKey(
    fiatCurrency,
    currency,
    network,
    input.destinationWalletAddress
  );
  const entry = readBvnkOnrampPaymentRuleState(providerData, key);

  if (
    !isBvnkCustomerVerified(customer.status) ||
    !entry.ruleId ||
    !entry.bankAccount?.accountNumber
  ) {
    throw counterpartyNotProvisioned("bvnk", "onramp", { customerStatus: customer.status });
  }
  const instruction = buildBvnkOnrampInstruction(
    {
      customer,
      entry,
      onboardingStatus: "ready",
    },
    {
      network,
      destinationWalletAddress: input.destinationWalletAddress,
      fiatCurrency,
      mode: resolveSdpEnvironment(c),
    }
  );
  return {
    provider: "bvnk",
    id: rampId("bvnk_onramp"),
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions: [instruction],
  };
}
