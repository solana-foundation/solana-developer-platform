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
  BvnkAgreementSession,
  BvnkCustomerIndividual,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletProfileV2,
  BvnkLedgerWalletV2,
  BvnkOnrampTransferProviderData,
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
} from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { getClientIp } from "@/lib/client-ip";
import { AppError, badRequest, counterpartyNotProvisioned, internalError } from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { getLogger } from "@/runtime/logger";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import type { Env } from "@/types/env";
import {
  type AppContext,
  getPaymentsRepository,
  rampRuntime,
  resolveSdpEnvironment,
} from "../../context";

const BVNK_UNRESOLVED_CONSENT_IP = "0.0.0.0";

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
  const wallet = await client.createLedgerWalletV2(ctx, {
    name: walletName,
    currency: fiatCurrency,
    profileId: walletProfile.id,
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
  await persistBvnkOfframpBeneficiary(c, input.counterparty, input.projectId, beneficiary);
  return beneficiary;
}

export type BvnkCustomerEnsureResult =
  | { customer: BvnkCustomerResolution }
  | { requirements: CounterpartyRequirements };

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

export type BvnkStoredSessionAgreements = NonNullable<
  BvnkCustomerProviderAccountMetadata["session"]
>["agreements"];

/**
 * Maps provider agreement-session entries to the stored and presented shape.
 *
 * @param agreements - Provider agreement session entries.
 * @returns The stored agreement subset.
 */
function toStoredSessionAgreements(
  agreements: BvnkAgreementSession["agreements"]
): BvnkStoredSessionAgreements {
  return agreements.map((agreement) => ({
    name: agreement.name,
    displayName: agreement.displayName,
    description: agreement.description,
    url: agreement.url,
    privacyPolicyUrl: agreement.privacyPolicyUrl,
  }));
}

/**
 * The pre-customer stage recorded on the BVNK customer-link row, resolved
 * without any provider call.
 */
export type BvnkStoredStage =
  | {
      kind: "agreements_pending";
      sessionReference: string;
      agreements: BvnkStoredSessionAgreements;
    }
  | {
      kind: "collect_counterparty";
      sessionReference: string;
      residenceCountryCode: CountryCode;
    };

/**
 * Reads the pre-customer stage recorded on the BVNK customer-link row without
 * any provider call, so callers can gate or branch on it before deciding
 * whether the stage is actually presented to the client.
 *
 * @param metadata - Stored BVNK customer-link metadata.
 * @returns The pending agreements, the collect step, or null once the customer exists.
 * @throws When the link predates the v1 session flow.
 */
export function bvnkStoredStage(
  metadata: BvnkCustomerProviderAccountMetadata
): BvnkStoredStage | null {
  if (metadata.status !== undefined) {
    return null;
  }
  const session = metadata.session;
  if (session === undefined) {
    throw internalError("BVNK customer-link metadata is missing session state.");
  }
  if (session.signedAt === undefined) {
    return {
      kind: "agreements_pending",
      sessionReference: session.reference,
      agreements: session.agreements,
    };
  }
  return {
    kind: "collect_counterparty",
    sessionReference: session.reference,
    residenceCountryCode: requireBvnkResidenceCountry(metadata),
  };
}

/**
 * Presents a stored stage to the client. The agreement step surfaces the
 * session's static help-centre links recorded at mint; nothing is minted
 * per response.
 *
 * @param direction - Ramp direction used in the requirement response.
 * @param stage - Stored stage from {@link bvnkStoredStage}.
 * @returns The client-facing requirement for the stage.
 */
export function presentBvnkStoredStage(
  direction: RampDirection,
  stage: BvnkStoredStage
): CounterpartyRequirements {
  switch (stage.kind) {
    case "agreements_pending":
      return {
        provider: "bvnk",
        direction,
        status: "counterparty_collect_agreement",
        agreements: stage.agreements,
      };
    case "collect_counterparty":
      return bvnkCollectCounterparty(direction, stage.residenceCountryCode);
    default: {
      const exhaustive: never = stage;
      throw internalError(`Unhandled BVNK stored stage: ${String(exhaustive)}`);
    }
  }
}

export function bvnkCustomerRequirementsFromMetadata(
  direction: RampDirection,
  metadata: BvnkCustomerProviderAccountMetadata
): CounterpartyRequirements | null {
  const stage = bvnkStoredStage(metadata);
  return stage === null ? null : presentBvnkStoredStage(direction, stage);
}

/**
 * Persists the BVNK customer link at session mint, before any PII besides
 * the residence country is known. The partner-supplied externalReference is
 * the provider_customer_reference until the v1 customer exists.
 *
 * @param c - Request context used for repository access.
 * @param counterparty - Counterparty receiving the BVNK customer link.
 * @param projectId - Project that owns the counterparty.
 * @param session - Session reference and the stored subset of its agreements.
 * @param residenceCountryCode - Residence country the session was minted for.
 * @returns Nothing.
 */
async function persistBvnkAgreementSession(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  session: { reference: string; agreements: BvnkStoredSessionAgreements },
  residenceCountryCode: CountryCode
): Promise<void> {
  await getCounterpartiesRepository(c).upsertBvnkCustomerProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    customer: {
      customerReference: buildBvnkCustomerExternalReference(counterparty.id),
      residenceCountryCode,
      session,
    },
  });
}

/**
 * Moves the v1 customer reference onto the customer-link row with a
 * compare-and-swap against the stored pre-customer alias, replacing the
 * pre-customer metadata with `{status}`. A lost CAS means a concurrent create
 * already assigned the reference, so the row is re-read: the concurrent
 * assignment of the same reference converges, anything else is an internal
 * error.
 *
 * @param c - Request context used for repository access.
 * @param input - Tenant scope, row id, the alias to swap from, and the v1 customer.
 * @returns The customer resolution carried by the link row.
 */
async function assignBvnkCustomerLink(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    providerAccountId: string;
    fromProviderCustomerReference: string;
    customer: { customerReference: string; status: string };
  }
): Promise<BvnkCustomerResolution> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const assigned = await accounts.assignCustomerLinkReference({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk",
    id: input.providerAccountId,
    fromProviderCustomerReference: input.fromProviderCustomerReference,
    providerCustomerReference: input.customer.customerReference,
    metadata: { status: input.customer.status },
  });
  if (assigned !== null) {
    getLogger().info(
      {
        counterparty_id: input.counterparty.id,
        customer_reference: input.customer.customerReference,
        outcome: "assigned",
      },
      "[bvnk customer] v1 customer reference assigned to customer link"
    );
    return input.customer;
  }
  const current = await accounts.getProviderAccount({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk",
  });
  if (
    current === null ||
    current.provider_customer_reference !== input.customer.customerReference
  ) {
    throw internalError("BVNK customer-link row changed underneath the reference assignment.");
  }
  const metadata = bvnkCustomerProviderAccountMetadataSchema.parse(current.metadata);
  if (metadata.status === undefined) {
    throw internalError("BVNK customer-link row is missing its customer status.");
  }
  getLogger().info(
    {
      counterparty_id: input.counterparty.id,
      customer_reference: current.provider_customer_reference,
      outcome: "converged",
    },
    "[bvnk customer] v1 customer reference assigned to customer link"
  );
  return {
    customerReference: current.provider_customer_reference,
    status: metadata.status,
  };
}

/**
 * Creates the v1 BVNK customer after the signed agreement session, persisting
 * the v1 reference and status onto the customer-link row.
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
    sessionReference: string;
    individual: BvnkCustomerIndividual;
    providerAccountId: string;
  }
): Promise<{ customer: BvnkCustomerResolution }> {
  const created = await input.client.createCustomer(input.ctx, {
    idempotencyKey: (await hashString(`bvnk-customer:${input.counterparty.id}`)).slice(0, 36),
    externalReference: input.reference,
    signedAgreementSessionReference: input.sessionReference,
    individual: input.individual,
  });
  const customer = await assignBvnkCustomerLink(c, {
    counterparty: input.counterparty,
    projectId: input.projectId,
    providerAccountId: input.providerAccountId,
    fromProviderCustomerReference: input.reference,
    customer: { customerReference: created.reference, status: created.status },
  });
  return { customer };
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
 * Reads the v1 customer from BVNK by its stored reference, patches status and
 * verification status onto the customer-link row, and returns the resolution
 * with its verification link when BVNK supplies one. A PENDING customer is in
 * review and carries no Sumsub link until BVNK requires action, so the link is
 * only required once the status maps to verification_required, which
 * bvnkOnboardingRequirements enforces.
 *
 * @param env - Request environment used for repository access.
 * @param ctx - Ramp runtime context used for provider access.
 * @param input - Tenant scope, row id, and the v1 customer reference.
 * @returns The refreshed customer resolution and its verification link.
 */
export async function refreshBvnkCustomerAccount(
  env: Env,
  ctx: RampRuntimeContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    providerAccountId: string;
    customerReference: string;
  }
): Promise<{ customer: BvnkCustomerResolution; verificationUrl: string | undefined }> {
  const latest = await RAMP_PROVIDER_CLIENTS.bvnk.getCustomer(ctx, {
    reference: input.customerReference,
  });
  const verification = latest.verification;
  const verificationStatus = verification?.status;
  const set: BvnkCustomerProviderAccountMetadata = {
    status: latest.status,
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
  };
  const updated = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(env)
  ).patchAccountMetadata({
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk",
    id: input.providerAccountId,
    set,
    unset: [],
  });
  if (updated === null) {
    throw internalError("BVNK customer status update escaped its tenant scope.");
  }
  return {
    customer: {
      customerReference: latest.reference,
      status: latest.status,
      ...(verificationStatus === undefined ? {} : { verificationStatus }),
    },
    verificationUrl: verification === undefined ? undefined : verification.url,
  };
}

/**
 * Advances the BVNK customer lifecycle: mints an agreement session on the
 * first residence step, signs it on consent with the consenting user's IP,
 * creates the v1 customer from the collected PII pack, or refreshes the
 * stored customer from BVNK.
 *
 * @param c - Request context used for provider and repository access.
 * @param counterparty - Counterparty whose provider state is resolved.
 * @param projectId - Project that owns the counterparty.
 * @param direction - Ramp direction used when returning an intermediate requirement.
 * @param collectedData - Residence country on the first step; the full PII pack
 * once the session is signed. Never persisted.
 * @param agreementConsent - Signs the stored agreement session when true.
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
          sessionReference: stage.sessionReference,
          individual: buildBvnkCustomerRequest(collectedData, stage.residenceCountryCode),
          providerAccountId: existing.id,
        });
      }
      if (stage.kind === "agreements_pending" && agreementConsent !== undefined) {
        const ipAddress = getClientIp(c);
        await client.signAgreementSession(ctx, {
          reference: stage.sessionReference,
          ipAddress: ipAddress === null ? BVNK_UNRESOLVED_CONSENT_IP : ipAddress,
        });
        const now = new Date().toISOString();
        const updated = await accounts.patchAccountMetadata({
          organizationId: counterparty.organization_id,
          projectId,
          counterpartyId: counterparty.id,
          provider: "bvnk",
          id: existing.id,
          set: {
            session: {
              ...metadata.session,
              signedAt: now,
            },
          },
          unset: [],
        });
        if (!updated) {
          throw internalError("BVNK agreement consent update escaped its tenant scope.");
        }
        getLogger().info(
          {
            counterparty_id: counterparty.id,
            session_reference: stage.sessionReference,
            signed_at: now,
          },
          "[bvnk consent] agreement session signed"
        );
        return {
          requirements: bvnkCollectCounterparty(direction, requireBvnkResidenceCountry(metadata)),
        };
      }
      return { requirements: presentBvnkStoredStage(direction, stage) };
    }
    const refreshed = await refreshBvnkCustomerAccount(c.env, ctx, {
      counterparty,
      projectId,
      providerAccountId: existing.id,
      customerReference: existing.provider_customer_reference,
    });
    return { customer: refreshed.customer };
  }

  if (collectedData === undefined) {
    throw badRequest("collectedData with the BVNK residence country is required.");
  }
  const residenceCountry = parseBvnkResidenceCountry(collectedData);
  const session = await client.createAgreementSession(ctx, { countryCode: residenceCountry });
  const stored = {
    reference: session.reference,
    agreements: toStoredSessionAgreements(session.agreements),
  };
  await persistBvnkAgreementSession(c, counterparty, projectId, stored, residenceCountry);
  return {
    requirements: presentBvnkStoredStage(direction, {
      kind: "agreements_pending",
      sessionReference: stored.reference,
      agreements: stored.agreements,
    }),
  };
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
    entry = { ...entry, ruleId: rule.id, ruleStatus: rule.status };
    await persistBvnkOnrampState(repository, counterparty, projectId, paymentRuleKey, entry);
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
): Promise<{ quote: BvnkOnrampQuote; transferProviderData: BvnkOnrampTransferProviderData }> {
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
    !entry.walletId ||
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
        fundingWalletId: entry.walletId,
      },
    },
  };
}
