import { randomUUID } from "node:crypto";
import { hashString } from "@sdp/payments/hash";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  buildBvnkCustomerRequest,
  parseBvnkResidenceCountry,
} from "@sdp/payments/ramps/providers/bvnk/counterparty";
import {
  type BvnkCustomerResolution,
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
  buildBvnkWalletIdempotencyKey,
  bvnkRuleReference,
  bvnkUnverifiedOnboardingStatus,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  readBvnkData,
  readBvnkOfframpBeneficiaries,
  readBvnkOfframpBeneficiaryByKey,
  readBvnkOfframpWallet,
  readBvnkOfframpWallets,
  readBvnkOnrampPaymentRuleState,
  readBvnkWallets,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  bvnkOfframpAccountType,
  bvnkOfframpFields,
  bvnkOnrampFields,
  isBvnkOfframpCurrency,
} from "@sdp/payments/ramps/providers/bvnk/requirements";
import type {
  BvnkAgreementsV2,
  BvnkCustomerV2Individual,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletProfileV2,
  BvnkLedgerWalletV2,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import { buildRequirementSchema } from "@sdp/payments/ramps/requirements";
import { rampId } from "@sdp/payments/ramps/shared";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type {
  BvnkBankFundingDetails,
  BvnkPaymentRampInstruction,
  CountryCode,
  CryptoRailId,
  PaymentRampQuote,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { getDb } from "@/db";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import {
  type BvnkCustomerProviderAccountMetadata,
  bvnkCustomerProviderAccountMetadataSchema,
  type CounterpartyProviderAccountRow,
  type CounterpartyProviderAccountsRepository,
} from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import {
  AppError,
  badRequest,
  counterpartyNotProvisioned,
  internalError,
  providerUnavailable,
} from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import type { Env } from "@/types/env";
import {
  type AppContext,
  getPaymentsRepository,
  rampRuntime,
  resolveSdpEnvironment,
} from "../../context";

/** Creates the pending off-ramp transfer row that anchors a BVNK channel quote. */
export async function createPendingBvnkOfframpTransfer(
  c: AppContext,
  input: {
    transferId: string;
    organizationId: string;
    projectId: string;
    counterpartyId: string;
    custodyWalletId: string;
    walletId: string;
    walletAddress: string;
    assetRail: CryptoRailId;
    cryptoAmount: string;
    fiatCurrency: RampFiatCurrency;
    rampsMemo: Record<string, string> | undefined;
  }
): Promise<PaymentTransferRow> {
  const apiKey = c.get("apiKey");
  const created = await getPaymentsRepository(c).createTransfer({
    id: input.transferId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.custodyWalletId,
    walletId: input.walletId,
    counterpartyId: input.counterpartyId,
    sourceAddress: input.walletAddress,
    destinationAddress: null,
    token: rampTransferTokenMint(input.assetRail, c.env),
    amount: input.cryptoAmount,
    memo: null,
    type: "offramp",
    direction: "outbound",
    status: "pending",
    provider: "bvnk",
    providerReference: null,
    deliveryMode: null,
    fiatCurrency: input.fiatCurrency,
    fiatAmount: null,
    rampsMemo: input.rampsMemo,
    providerData: {},
    serializedTx: null,
    signature: null,
    slot: null,
    initiatedByKeyId: apiKey ? apiKey.id : null,
  });
  if (!created) {
    throw internalError("Failed to create ramp transfer record");
  }
  return created;
}

/** Stamps the pending BVNK off-ramp transfer with the quote's reference, delivery mode, and status. */
export async function completePendingBvnkOfframpTransfer(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string;
    transferId: string;
    quote: PaymentRampQuote;
    status: PaymentTransferStatus;
  }
): Promise<void> {
  const updated = await getPaymentsRepository(c).updateTransfer({
    transferId: input.transferId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: input.status,
    providerReference: input.quote.id,
    deliveryMode: input.quote.deliveryMode,
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    throw internalError("Failed to complete BVNK off-ramp transfer record");
  }
}

type BvnkOnrampQuote = PaymentRampQuote & {
  provider: "bvnk";
  deliveryMode: "manual_instructions";
  paymentInstructions: BvnkPaymentRampInstruction[];
};

/**
 * Selects the BVNK wallet profile that supports the requested fiat currency.
 *
 * @param profiles - Profiles returned by BVNK's v2 ledger API.
 * @param fiatCurrency - Requested fiat currency code.
 * @returns The matching wallet profile.
 */
function selectBvnkWalletProfile(
  profiles: BvnkLedgerWalletProfilesV2,
  fiatCurrency: string
): BvnkLedgerWalletProfileV2 {
  const profile = profiles.content.find((entry) =>
    entry.currencies.some((currency) => currency.toUpperCase() === fiatCurrency.toUpperCase())
  );
  if (profile === undefined) {
    throw internalError(`No BVNK ${fiatCurrency} wallet profile is available.`);
  }
  return profile;
}

/**
 * Maps the first BVNK fiat payment instrument into the persisted bank-account shape.
 *
 * @param wallet - BVNK v2 ledger wallet.
 * @returns Persistable bank details, or undefined when no instrument is present.
 */
function bvnkWalletBankAccount(wallet: BvnkLedgerWalletV2): BvnkBankFundingDetails | undefined {
  const instrument = wallet.paymentInstruments?.[0];
  if (instrument === undefined) {
    return undefined;
  }
  return {
    accountNumber: instrument.accountNumber,
    code: instrument.bankDetails.bic,
    paymentReference: instrument.remittanceInformationPrefix,
    bankName: instrument.bankDetails.name,
  };
}

async function persistBvnkOnrampState(
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  projectId: string,
  key: string,
  entry: BvnkOnrampPaymentRuleState
): Promise<void> {
  // TODO(PRO-1823): Move BVNK on-ramp state to counterparty_provider_accounts.
  await repo.mutateProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    mutate(providerData) {
      const bvnk = readBvnkData(providerData);
      const wallets = readBvnkWallets(providerData);
      return {
        ...providerData,
        bvnk: {
          ...bvnk,
          wallets: { ...wallets, [key]: { ...wallets[key], ...entry } },
        },
      };
    },
  });
}

/** Persists a merchant-owned off-ramp wallet to provider_data.bvnk.offramp.wallets. */
async function persistBvnkOfframpWallet(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  fiatCurrency: string,
  wallet: BvnkLedgerWalletV2
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
  // TODO(PRO-1824): Move BVNK merchant-wallet state to counterparty_provider_accounts.
  await repo.mutateProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    mutate(providerData) {
      const bvnk = readBvnkData(providerData);
      const offramp =
        bvnk.offramp && typeof bvnk.offramp === "object"
          ? (bvnk.offramp as Record<string, unknown>)
          : {};
      const wallets = readBvnkOfframpWallets(providerData);
      return {
        ...providerData,
        bvnk: {
          ...bvnk,
          offramp: {
            ...offramp,
            wallets: { ...wallets, [fiatCurrency]: { id: wallet.id, status: wallet.status } },
          },
        },
      };
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
 * keep returning `customer_funding_account_provisioning` until BVNK activates it.
 */
/**
 * Admits and resolves a BVNK provisioning step in the tamper-evident ledger.
 * Provider-side objects created here (customers, wallets, payout
 * beneficiaries, payment rules, agreement working sets) decide where future
 * settlements land, so their creation must be attributable; the route path
 * binds the request actor, the webhook path a system actor.
 *
 * Intent/outcome, not a single entry: `begin` writes a durable intent BEFORE
 * the effect — a refused ledger write aborts the step while it is still
 * retryable — and `complete` resolves it with the provider-assigned ids after
 * the local state is persisted. An effect that dies between the two leaves an
 * unresolved intent, which is exactly what the unresolved-intent verification
 * gate pages on; the ledger never claims a creation that did not happen.
 */
export interface BvnkProvisioningAudit {
  begin(event: { action: string; metadata: Record<string, unknown> }): Promise<AuditIntent>;
  complete(intent: AuditIntent, metadata?: Record<string, unknown>): Promise<void>;
}

export function requestProvisioningAudit(
  c: AppContext,
  counterparty: CounterpartyRow
): BvnkProvisioningAudit {
  const service = new AuditService(getDb(c.env));
  return {
    async begin({ action, metadata }) {
      return service.beginCritical(c, {
        action: "update",
        resourceType: "counterparty",
        resourceId: counterparty.id,
        metadata: { action, provider: "bvnk", ...metadata },
      });
    },
    async complete(intent, metadata = {}) {
      await service.completeCritical(c, intent, { metadata });
    },
  };
}

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
    const refreshed = await client.getLedgerWalletV2(ctx, { walletId: existing.id });
    if (refreshed.status !== existing.status) {
      await persistBvnkOfframpWallet(c, counterparty, projectId, fiatCurrency, refreshed);
    }
    return { id: refreshed.id, status: refreshed.status };
  }
  const walletProfile = selectBvnkWalletProfile(
    await client.listLedgerWalletProfilesV2(ctx, { currency: fiatCurrency }),
    fiatCurrency
  );
  const walletName = buildBvnkOfframpWalletName(fiatCurrency, counterparty.id);
  const audit = requestProvisioningAudit(c, counterparty);
  const intent = await audit.begin({
    action: "bvnk_offramp_wallet_created",
    metadata: { walletName, fiatCurrency },
  });
  const wallet = await client.createLedgerWalletV2(ctx, {
    name: walletName,
    currency: fiatCurrency,
    profileId: walletProfile.id,
    idempotencyKey: await buildBvnkWalletIdempotencyKey(walletName),
  });
  await persistBvnkOfframpWallet(c, counterparty, projectId, fiatCurrency, wallet);
  await audit.complete(intent, { walletId: wallet.id });
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
  // TODO(PRO-1824): Move BVNK beneficiary state to counterparty_provider_accounts.
  await repo.mutateProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    mutate(providerData) {
      const bvnk = readBvnkData(providerData);
      const offramp =
        bvnk.offramp && typeof bvnk.offramp === "object"
          ? (bvnk.offramp as Record<string, unknown>)
          : {};
      const beneficiaries = readBvnkOfframpBeneficiaries(providerData);
      return {
        ...providerData,
        bvnk: {
          ...bvnk,
          offramp: {
            ...offramp,
            beneficiaries: { ...beneficiaries, [beneficiary.key]: beneficiary },
          },
        },
      };
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
  // The beneficiary marker binds this counterparty to a real-world payout
  // destination; who registered it is the fact disputes turn on.
  const audit = requestProvisioningAudit(c, input.counterparty);
  const intent = await audit.begin({
    action: "bvnk_offramp_beneficiary_registered",
    metadata: { key, fiatCurrency, accountType: beneficiary.accountType },
  });
  await persistBvnkOfframpBeneficiary(c, input.counterparty, input.projectId, beneficiary);
  await audit.complete(intent);
  return beneficiary;
}

export type BvnkCustomerEnsureResult =
  | { customer: BvnkCustomerResolution }
  | { requirements: CounterpartyRequirements };

/**
 * Builds the agreement-consent requirement for the pending agreements. Document
 * URLs are presigned per response and never persisted.
 *
 * @param c - Request context used for JIT agreement content URLs.
 * @param direction - Ramp direction used in the requirement response.
 * @param agreements - Pending agreements awaiting consent.
 * @returns The agreement-required requirement with JIT document URLs.
 */
async function bvnkAgreementRequired(
  c: AppContext,
  direction: RampDirection,
  agreements: readonly { id: string; name: string; description: string }[]
): Promise<CounterpartyRequirements> {
  return {
    provider: "bvnk",
    direction,
    status: "customer_agreement_required",
    agreements: await Promise.all(
      agreements.map(async (agreement) => {
        const content = await RAMP_PROVIDER_CLIENTS.bvnk.getAgreementContentV2(rampRuntime(c), {
          id: agreement.id,
        });
        return {
          id: agreement.id,
          name: agreement.name,
          description: agreement.description,
          downloadUrl: content.downloadUrl,
        };
      })
    ),
  };
}

/**
 * Builds the collect-counterparty requirement for a residence country.
 *
 * @param direction - Ramp direction used in the requirement response.
 * @param residenceCountryCode - Tax-residence country the fields were minted for.
 * @returns The collect-counterparty requirement with the residence fields.
 */
export function bvnkCollectCounterparty(
  direction: RampDirection,
  residenceCountryCode: CountryCode
): CounterpartyRequirements {
  return {
    provider: "bvnk",
    direction,
    status: "collect_counterparty",
    fields: bvnkOnrampFields(residenceCountryCode),
  };
}

/**
 * Builds agreement requirements from a BVNK working set.
 *
 * @param c - Request context used for provider access.
 * @param direction - Ramp direction used in the requirement response.
 * @param agreements - BVNK working-set response.
 * @returns BVNK agreement requirements with JIT document URLs.
 */
async function bvnkAgreementDetails(
  c: AppContext,
  direction: RampDirection,
  agreements: BvnkAgreementsV2
): Promise<CounterpartyRequirements> {
  const pending = agreements.agreements.filter((agreement) => agreement.status !== "ACCEPTED");
  return bvnkAgreementRequired(
    c,
    direction,
    pending.map((agreement) => ({
      id: agreement.id,
      name: agreement.name,
      description: agreement.description,
    }))
  );
}

/**
 * @param metadata - Stored BVNK customer-link metadata.
 * @returns The residence country the link was minted for.
 * @throws When the link predates residence-first onboarding.
 */
function requireBvnkResidenceCountry(metadata: BvnkCustomerProviderAccountMetadata): CountryCode {
  const residenceCountryCode = metadata.residenceCountryCode;
  if (residenceCountryCode === undefined) {
    throw internalError("BVNK customer-link metadata is missing residence country.");
  }
  return residenceCountryCode;
}

type BvnkAgreementEntries = NonNullable<
  BvnkCustomerProviderAccountMetadata["agreements"]
>["entries"];

/**
 * Resolves stored BVNK agreement state without reading customer state from BVNK.
 *
 * @param c - Request context used for JIT agreement content URLs.
 * @param direction - Ramp direction used in the requirement response.
 * @param metadata - Stored BVNK customer-link metadata.
 * @returns The next stored agreement requirement, or null when customer resolution may continue.
 */
export type BvnkStoredStage =
  | { kind: "agreements_pending"; agreements: { id: string; name: string; description: string }[] }
  | { kind: "collect_counterparty"; residenceCountryCode: CountryCode };

/**
 * Reads the pre-customer stage recorded on the BVNK customer-link row without
 * any provider call, so callers can gate or branch on it before deciding
 * whether the stage is actually presented to the client.
 *
 * @param metadata - Stored BVNK customer-link metadata.
 * @returns The pending agreements, the collect step, or null once the customer exists.
 */
export function bvnkStoredStage(
  metadata: BvnkCustomerProviderAccountMetadata
): BvnkStoredStage | null {
  const agreements = metadata.agreements;
  if (agreements === undefined) {
    return null;
  }
  const pending = Object.entries(agreements.entries)
    .filter(([, entry]) => entry.status.toUpperCase() !== "ACCEPTED")
    .map(([id, entry]) => ({ id, name: entry.name, description: entry.description }));
  if (pending.length > 0) {
    return { kind: "agreements_pending", agreements: pending };
  }
  if (metadata.status === undefined) {
    return {
      kind: "collect_counterparty",
      residenceCountryCode: requireBvnkResidenceCountry(metadata),
    };
  }
  return null;
}

/**
 * Presents a stored stage to the client; the agreement step mints its
 * presigned document URLs here and nowhere earlier.
 *
 * @param c - Request context used for JIT agreement content URLs.
 * @param direction - Ramp direction used in the requirement response.
 * @param stage - Stored stage from {@link bvnkStoredStage}.
 * @returns The client-facing requirement for the stage.
 */
export function presentBvnkStoredStage(
  c: AppContext,
  direction: RampDirection,
  stage: BvnkStoredStage
): Promise<CounterpartyRequirements> {
  switch (stage.kind) {
    case "agreements_pending":
      return bvnkAgreementRequired(c, direction, stage.agreements);
    case "collect_counterparty":
      return Promise.resolve(bvnkCollectCounterparty(direction, stage.residenceCountryCode));
    default: {
      const exhaustive: never = stage;
      throw internalError(`Unhandled BVNK stored stage: ${String(exhaustive)}`);
    }
  }
}

export async function bvnkCustomerRequirementsFromMetadata(
  c: AppContext,
  direction: RampDirection,
  metadata: BvnkCustomerProviderAccountMetadata
): Promise<CounterpartyRequirements | null> {
  const stage = bvnkStoredStage(metadata);
  return stage === null ? null : presentBvnkStoredStage(c, direction, stage);
}

/**
 * Persists the BVNK customer link at agreement mint, before any PII besides
 * the residence country is known.
 *
 * @param c - Request context used for repository access.
 * @param counterparty - Counterparty receiving the BVNK customer link.
 * @param projectId - Project that owns the counterparty.
 * @param workingSetId - BVNK agreements working-set id (the v2 customer UUID space).
 * @param entries - Required agreement state to persist.
 * @param residenceCountryCode - Residence country the agreements were minted for.
 * @returns Nothing.
 */
async function persistBvnkAgreementState(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  workingSetId: string,
  entries: BvnkAgreementEntries,
  residenceCountryCode: CountryCode
): Promise<void> {
  await getCounterpartiesRepository(c).upsertBvnkCustomerProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    customer: {
      customerReference: workingSetId,
      residenceCountryCode,
      agreements: { entries },
    },
  });
}

/**
 * Creates the BVNK customer after agreement confirmation.
 *
 * @param c - Request context used for persistence.
 * @param input - Provider inputs and transient customer data.
 * @returns The created customer resolution.
 */
async function createBvnkCustomer(
  c: AppContext,
  input: {
    client: typeof RAMP_PROVIDER_CLIENTS.bvnk;
    ctx: RampRuntimeContext;
    counterparty: CounterpartyRow;
    projectId: string;
    reference: string;
    individual: BvnkCustomerV2Individual;
  }
): Promise<{ customer: BvnkCustomerResolution }> {
  const audit = requestProvisioningAudit(c, input.counterparty);
  const intent = await audit.begin({
    action: "bvnk_customer_created",
    metadata: { reference: input.reference },
  });
  const created = await input.client.createCustomerV2(input.ctx, {
    idempotencyKey: (await hashString(`bvnk-customer:${input.counterparty.id}`)).slice(0, 36),
    useCase: "FIAT",
    reference: input.reference,
    individual: input.individual,
  });
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const existing = await accounts.getProviderAccount({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk",
  });
  if (!existing) {
    throw internalError("BVNK customer-link row is missing after agreement relay.");
  }
  const updated = await accounts.patchAccountMetadata({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk",
    id: existing.id,
    set: { status: created.status },
    unset: ["residenceCountryCode"],
  });
  if (!updated) {
    throw internalError("BVNK customer status update escaped its tenant scope.");
  }
  await audit.complete(intent, {
    customerReference: created.id ?? null,
    status: created.status ?? null,
  });
  return { customer: { customerReference: created.id, status: created.status } };
}

/**
 * Reads the BVNK customer state from the counterparty's customer-link provider-account row.
 *
 * @param c - Request context.
 * @param counterparty - Owning counterparty row.
 * @returns The row-backed customer resolution, or null when no BVNK customer exists.
 */
export async function readBvnkCustomerLink(
  env: Env,
  counterparty: CounterpartyRow
): Promise<BvnkCustomerResolution | null> {
  const link = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(env)
  ).getProviderAccount({
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    counterpartyId: counterparty.id,
    provider: "bvnk",
  });
  if (!link) {
    return null;
  }
  const metadata = bvnkCustomerProviderAccountMetadataSchema.parse(link.metadata);
  if (metadata.status === undefined) {
    return null;
  }
  return {
    customerReference: link.provider_customer_reference,
    status: metadata.status,
    verificationStatus: metadata.verificationStatus,
  };
}

/**
 * Accepts every stored pending agreement and consumes the action response as
 * BVNK's authoritative per-agreement answer (probe Q1d/Q4.1): a per-item
 * `status: "ACCEPTED"` confirms the agreement so the customer create may
 * proceed immediately; a per-item `error` fails the consent advance.
 *
 * @param c - Request context used for provider and repository access.
 * @param input - Link row, stored working set, and the pending agreement ids to accept.
 * @returns The collect-counterparty requirement for the accepted working set.
 */
async function acceptBvnkAgreements(
  c: AppContext,
  input: {
    accounts: CounterpartyProviderAccountsRepository;
    counterparty: CounterpartyRow;
    projectId: string;
    direction: RampDirection;
    existing: CounterpartyProviderAccountRow;
    metadata: BvnkCustomerProviderAccountMetadata;
    pendingIds: readonly string[];
  }
): Promise<{ requirements: CounterpartyRequirements }> {
  const agreements = input.metadata.agreements;
  if (agreements === undefined) {
    throw internalError("BVNK customer-link metadata is missing agreement state.");
  }
  // Accepting agreements is the counterparty's recorded consent; who relayed
  // it is attribution-worthy, and the entry precedes the provider call.
  const agreementAudit = requestProvisioningAudit(c, input.counterparty);
  const agreementIntent = await agreementAudit.begin({
    action: "bvnk_agreements_accepted",
    metadata: { agreementIds: [...input.pendingIds] },
  });
  const results = await RAMP_PROVIDER_CLIENTS.bvnk.respondAgreementsV2(rampRuntime(c), {
    idempotencyKey: randomUUID(),
    reference: buildBvnkCustomerExternalReference(input.counterparty.id),
    actions: input.pendingIds.map((agreementId) => ({ agreementId, type: "ACCEPT" })),
  });
  const entries = { ...agreements.entries };
  const respondedAt = new Date().toISOString();
  const respondedIds = new Set<string>();
  for (const item of results.content) {
    respondedIds.add(item.agreementId);
    if (item.error !== undefined) {
      getLogger().warn(
        {
          counterparty_id: input.counterparty.id,
          agreement_id: item.agreementId,
          provider_error_code: item.error.code,
          provider_error_message: item.error.message,
        },
        "[bvnk agreements] BVNK rejected an agreement action"
      );
      throw providerUnavailable("BVNK rejected an agreement action.");
    }
    if (item.status !== "ACCEPTED") {
      throw internalError("BVNK agreement action response did not confirm acceptance.");
    }
    const entry = entries[item.agreementId];
    if (entry === undefined) {
      throw internalError(
        "BVNK agreement action response named an agreement outside the stored working set."
      );
    }
    entries[item.agreementId] = { ...entry, status: "ACCEPTED", respondedAt };
  }
  for (const agreementId of input.pendingIds) {
    if (!respondedIds.has(agreementId)) {
      throw internalError("BVNK agreement action response omitted a stored pending agreement.");
    }
  }
  const updated = await input.accounts.patchAccountMetadata({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk",
    id: input.existing.id,
    set: { agreements: { ...agreements, entries } },
    unset: [],
  });
  if (!updated) {
    throw internalError("BVNK agreement acceptance escaped its tenant scope.");
  }
  await agreementAudit.complete(agreementIntent);
  return {
    requirements: bvnkCollectCounterparty(
      input.direction,
      requireBvnkResidenceCountry(input.metadata)
    ),
  };
}

/**
 * Creates or refreshes the BVNK v2 customer using transient collected PII.
 *
 * @param c - Request context used for provider and repository access.
 * @param counterparty - Counterparty whose provider state is resolved.
 * @param projectId - Project that owns the counterparty.
 * @param direction - Ramp direction used when returning an intermediate requirement.
 * @param collectedData - Residence country on the first step; the full PII pack
 * once agreements are accepted. Never persisted.
 * @param agreementConsent - Accepts every pending agreement in the working set when true.
 * @returns A refreshed customer or the next agreement requirement.
 */
export async function ensureBvnkCustomer(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  direction: RampDirection,
  collectedData?: CollectedFieldData,
  agreementConsent?: true
): Promise<BvnkCustomerEnsureResult> {
  if (counterparty.entity_type === "business") {
    throw badRequest("BVNK supports individual counterparties only.");
  }
  const ctx = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const existing = await accounts.getProviderAccount({
    organizationId: counterparty.organization_id,
    projectId,
    counterpartyId: counterparty.id,
    provider: "bvnk",
  });

  if (existing) {
    const metadata = bvnkCustomerProviderAccountMetadataSchema.parse(existing.metadata);
    const stage = bvnkStoredStage(metadata);
    if (stage !== null) {
      if (stage.kind === "collect_counterparty" && collectedData !== undefined) {
        return createBvnkCustomer(c, {
          client,
          ctx,
          counterparty,
          projectId,
          reference: buildBvnkCustomerExternalReference(counterparty.id),
          individual: buildBvnkCustomerRequest(collectedData, stage.residenceCountryCode),
        });
      }
      if (stage.kind === "agreements_pending" && agreementConsent !== undefined) {
        return acceptBvnkAgreements(c, {
          accounts,
          counterparty,
          projectId,
          direction,
          existing,
          metadata,
          pendingIds: stage.agreements.map((agreement) => agreement.id),
        });
      }
      return { requirements: await presentBvnkStoredStage(c, direction, stage) };
    }
    if (metadata.status === undefined) {
      throw internalError("BVNK customer-link metadata is missing agreement state.");
    }
    const latest = await client.getCustomerV2(ctx, { id: existing.provider_customer_reference });
    const updated = await accounts.patchAccountMetadata({
      organizationId: counterparty.organization_id,
      projectId,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: existing.id,
      set: { status: latest.status },
      unset: [],
    });
    if (!updated) {
      throw internalError("BVNK customer status update escaped its tenant scope.");
    }
    return {
      customer: { customerReference: existing.provider_customer_reference, status: latest.status },
    };
  }

  if (collectedData === undefined) {
    throw badRequest("collectedData with the BVNK residence country is required.");
  }
  const residenceCountry = parseBvnkResidenceCountry(collectedData);
  const reference = buildBvnkCustomerExternalReference(counterparty.id);
  const agreementsAudit = requestProvisioningAudit(c, counterparty);
  const agreementsIntent = await agreementsAudit.begin({
    action: "bvnk_agreements_created",
    metadata: { countryCode: residenceCountry },
  });
  const agreements = await client.createAgreementsV2(ctx, {
    idempotencyKey: (await hashString(`bvnk-agreements:${counterparty.id}`)).slice(0, 36),
    reference,
    useCase: "FIAT",
    customerType: "INDIVIDUAL",
    countryCode: residenceCountry,
  });
  const entries: BvnkAgreementEntries = Object.fromEntries(
    agreements.agreements.map((agreement) => [
      agreement.id,
      { status: agreement.status, name: agreement.name, description: agreement.description },
    ])
  );
  await persistBvnkAgreementState(
    c,
    counterparty,
    projectId,
    agreements.id,
    entries,
    residenceCountry
  );
  await agreementsAudit.complete(agreementsIntent, { agreementSetId: agreements.id });
  const pending = agreements.agreements.filter((agreement) => agreement.status !== "ACCEPTED");
  if (pending.length > 0) {
    return { requirements: await bvnkAgreementDetails(c, direction, agreements) };
  }
  return { requirements: bvnkCollectCounterparty(direction, residenceCountry) };
}

/**
 * Advances on-ramp provisioning (wallet profile → create/get wallet → create
 * rule) for a verified customer + funding spec. Persists entry state to
 * counterparty.provider_data.bvnk.wallets[key] after each completed step.
 */
export async function ensureBvnkPaymentRule(
  ctx: RampRuntimeContext,
  repository: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  projectId: string,
  customer: BvnkCustomerResolution,
  params: BvnkOnrampRequestSpec,
  audit: BvnkProvisioningAudit
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
    await persistBvnkOnrampState(repository, counterparty, projectId, paymentRuleKey, entry);
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
    const walletProfile = selectBvnkWalletProfile(
      await client.listLedgerWalletProfilesV2(ctx, {
        customerId: customer.customerReference,
        currency: params.fiatCurrency,
      }),
      params.fiatCurrency
    );
    const walletIntent = await audit.begin({
      action: "bvnk_onramp_wallet_created",
      metadata: { walletName, fiatCurrency: params.fiatCurrency },
    });
    const wallet = await client.createLedgerWalletV2(ctx, {
      customerId: customer.customerReference,
      name: walletName,
      currency: params.fiatCurrency,
      profileId: walletProfile.id,
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
      bankAccount: bvnkWalletBankAccount(wallet),
    };
    await persistBvnkOnrampState(repository, counterparty, projectId, paymentRuleKey, entry);
    await audit.complete(walletIntent, { walletId: wallet.id });
  }

  if (entry.walletId && !isBvnkWalletActive(entry.walletStatus)) {
    try {
      const wallet = await client.getLedgerWalletV2(ctx, { walletId: entry.walletId });
      entry = {
        ...entry,
        walletStatus: wallet.status,
        bankAccount: bvnkWalletBankAccount(wallet) ?? entry.bankAccount,
      };
      await persistBvnkOnrampState(repository, counterparty, projectId, paymentRuleKey, entry);
    } catch (error) {
      getLogger().warn(
        {
          wallet_id: entry.walletId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[bvnk onramp] wallet status refresh failed; relying on webhook"
      );
    }
  }

  if (!entry.ruleId && entry.walletId && isBvnkWalletActive(entry.walletStatus)) {
    const ruleIntent = await audit.begin({
      action: "bvnk_onramp_payment_rule_created",
      metadata: {
        currency: params.currency,
        network: params.network,
        destination: params.destinationWalletAddress,
      },
    });
    const rule = await client.createOnrampRule(ctx, {
      reference: await bvnkRuleReference(counterparty.id, paymentRuleKey),
      walletId: entry.walletId,
      currency: params.currency,
      network: params.network,
      beneficiaryAddress: params.destinationWalletAddress,
      entity: {
        type: "INDIVIDUAL",
        relationshipType: "SELF_OWNED",
        customerIdentifier: customer.customerReference,
      },
    });
    entry = { ...entry, ruleId: rule.id ?? entry.ruleId, ruleStatus: rule.status };
    await persistBvnkOnrampState(repository, counterparty, projectId, paymentRuleKey, entry);
    await audit.complete(ruleIntent, { ruleId: rule.id ?? null });
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
    customer: BvnkCustomerResolution;
    paymentRule: BvnkOnrampRequestSpec;
  }
): Promise<{
  quote: BvnkOnrampQuote;
  transferProviderData: {
    bvnk: { ruleId: string; ruleStatus?: string; fundingWalletId?: string };
  };
}> {
  const { currency, network, destinationWalletAddress, fiatCurrency } = input.paymentRule;
  const providerData = input.counterparty.provider_data;
  const customer = input.customer;
  const key = buildBvnkOnrampPaymentRuleKey(
    fiatCurrency,
    currency,
    network,
    destinationWalletAddress
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
      destinationWalletAddress,
      fiatCurrency,
      mode: resolveSdpEnvironment(c),
    }
  );
  return {
    quote: {
      provider: "bvnk",
      id: rampId("bvnk_onramp"),
      status: "pending",
      deliveryMode: "manual_instructions",
      paymentInstructions: [instruction],
    },
    transferProviderData: {
      bvnk: {
        ruleId: entry.ruleId,
        ...(entry.ruleStatus ? { ruleStatus: entry.ruleStatus } : {}),
        ...(entry.walletId ? { fundingWalletId: entry.walletId } : {}),
      },
    },
  };
}
