import { hashString } from "@sdp/payments/hash";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  buildBvnkCustomerRequest,
  bvnkResidenceRequired,
  parseBvnkResidenceCountry,
} from "@sdp/payments/ramps/providers/bvnk/counterparty";
import {
  BVNK_FUNDING_WALLET_CLAIM_TAKEOVER_MS,
  BVNK_FUNDING_WALLET_FIAT,
  BVNK_PAYOUT_NETWORK,
  type BvnkCustomerResolution,
  type BvnkOfframpBeneficiary,
  type BvnkOfframpWallet,
  buildBvnkCustomerExternalReference,
  buildBvnkFundingWalletName,
  buildBvnkOfframpWalletName,
  buildBvnkWalletIdempotencyKey,
  bvnkOnrampRemittance,
  bvnkPayoutPartyDetailsFromCustomer,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  readBvnkData,
  readBvnkOfframpBeneficiaries,
  readBvnkOfframpBeneficiaryByKey,
  readBvnkOfframpWallet,
  readBvnkOfframpWallets,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  bvnkOfframpAccountType,
  bvnkOfframpFields,
  bvnkOnrampFields,
  isBvnkOfframpCurrency,
} from "@sdp/payments/ramps/providers/bvnk/requirements";
import type {
  BvnkAgreementSession,
  BvnkCustomer,
  BvnkCustomerIndividual,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletProfileV2,
  BvnkLedgerWalletV2,
  BvnkOnrampPayoutInput,
  BvnkV2WalletListRow,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import { readStoredBvnkSettlement } from "@sdp/payments/ramps/providers/bvnk/settlement";
import { buildRequirementSchema } from "@sdp/payments/ramps/requirements";
import { rampId } from "@sdp/payments/ramps/shared";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { toNumberAmount } from "@sdp/solana/amount";
import type {
  BvnkBankFundingDetails,
  BvnkFiatFundingInstruction,
  BvnkPaymentRampInstruction,
  CountryCode,
  CryptoRailId,
  PaymentRampQuote,
} from "@sdp/types";
import { BVNK_FUNDING_WALLET_STATUS } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { getDb } from "@/db";
import type { BvnkOnrampPayoutIntent } from "@/db/repositories/bvnk-onramp-transfers.repository";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import {
  type BvnkCustomerProviderAccountMetadata,
  bvnkCustomerProviderAccountMetadataSchema,
  type CounterpartyProviderAccountRow,
  type CounterpartyProviderAccountsRepository,
  counterpartyProviderAccountUuid,
  type GetCounterpartyProviderAccountInput,
} from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { getClientIp } from "@/lib/client-ip";
import {
  AppError,
  badRequest,
  conflict,
  counterpartyNotProvisioned,
  internalError,
} from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import type { Env } from "@/types/env";
import { type AppContext, getPaymentsRepository, rampRuntime } from "../../context";

const BVNK_UNRESOLVED_CONSENT_IP = "0.0.0.0";

/** Builds the tenant scope of a BVNK provider-account row. */
function bvnkAccountScope(
  counterparty: CounterpartyRow,
  projectId: string
): GetCounterpartyProviderAccountInput {
  return {
    organizationId: counterparty.organization_id,
    projectId,
    counterpartyId: counterparty.id,
    provider: "bvnk",
  };
}

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
  const nid = instrument.bankDetails.nid;
  return {
    accountNumber: instrument.accountNumber,
    code: instrument.bankDetails.bic,
    paymentReference: instrument.remittanceInformationPrefix,
    ...(nid !== undefined && nid.type === "ROUTING_NUMBER" ? { routingNumber: nid.value } : {}),
    bankName: instrument.bankDetails.name,
  };
}

/** Persists an entry into provider_data.bvnk.offramp. */
async function persistBvnkOfframpData(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  mutateOfframp: (
    providerData: CounterpartyRow["provider_data"],
    offramp: Record<string, unknown>
  ) => Record<string, unknown>
): Promise<void> {
  const repo = getCounterpartiesRepository(c);
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
      return {
        ...providerData,
        bvnk: { ...bvnk, offramp: mutateOfframp(providerData, offramp) },
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
  await persistBvnkOfframpData(c, counterparty, projectId, (providerData, offramp) => {
    const wallets = readBvnkOfframpWallets(providerData);
    return {
      ...offramp,
      wallets: { ...wallets, [fiatCurrency]: { id: wallet.id, status: wallet.status } },
    };
  });
}

/**
 * Admits and resolves a BVNK provisioning step in the tamper-evident ledger:
 * `begin` writes a durable intent before the effect (a refused write aborts
 * the still-retryable step), `complete` resolves it once local state is
 * persisted, and `fail` records a failed attempt.
 */
export interface BvnkProvisioningAudit {
  begin(event: { action: string; metadata: Record<string, unknown> }): Promise<AuditIntent>;
  complete(intent: AuditIntent, metadata: Record<string, unknown>): Promise<void>;
  /** Resolves the intent as a failed attempt, so a routine provider error
   * does not strand an unresolved intent; ambiguous errors carry
   * providerOutcome: "unverified". */
  fail(intent: AuditIntent, error: unknown): Promise<void>;
}

/**
 * Binds a BVNK provisioning step to the tamper-evident ledger for a counterparty.
 *
 * @param c - Request context used for ledger access.
 * @param counterparty - Counterparty whose provisioning steps are admitted.
 * @returns The audit facade admitting begin/complete/fail.
 */
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
    async complete(intent, metadata) {
      await service.completeCritical(c, intent, { metadata });
    },
    async fail(intent, error) {
      await service.completeCritical(c, intent, {
        status: "failure",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          providerOutcome: "unverified",
        },
      });
    },
  };
}

/**
 * Provisions or reuses the merchant-owned BVNK fiat off-ramp wallet, keyed per
 * fiat currency; a stored inactive wallet is refreshed from BVNK.
 *
 * @param c - Request context used for provider and repository access.
 * @param ctx - Ramp runtime context used for provider access.
 * @param counterparty - Counterparty that owns the merchant wallet.
 * @param projectId - Project that owns the counterparty.
 * @param fiatCurrency - Fiat currency the wallet is provisioned for.
 * @returns The stored or created off-ramp wallet.
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
  const profiles = await client.listLedgerWalletProfilesV2(ctx, { currency: fiatCurrency });
  const walletProfile = selectBvnkWalletProfile(profiles, fiatCurrency);
  const walletName = buildBvnkOfframpWalletName(fiatCurrency, counterparty.id);
  const audit = requestProvisioningAudit(c, counterparty);
  const intent = await audit.begin({
    action: "bvnk_offramp_wallet_created",
    metadata: { walletName, fiatCurrency },
  });
  try {
    const wallet = await client.createLedgerWalletV2(ctx, {
      name: walletName,
      currency: fiatCurrency,
      profileId: walletProfile.id,
      idempotencyKey: await buildBvnkWalletIdempotencyKey(walletName),
    });
    await persistBvnkOfframpWallet(c, counterparty, projectId, fiatCurrency, wallet);
    await audit.complete(intent, { walletId: wallet.id });
    return { id: wallet.id, status: wallet.status };
  } catch (error) {
    await audit.fail(intent, error);
    throw error;
  }
}

/** Persists an off-ramp payout beneficiary marker to provider_data.bvnk.offramp.beneficiaries. */
async function persistBvnkOfframpBeneficiary(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  beneficiary: BvnkOfframpBeneficiary
): Promise<void> {
  await persistBvnkOfframpData(c, counterparty, projectId, (providerData, offramp) => {
    const beneficiaries = readBvnkOfframpBeneficiaries(providerData);
    return {
      ...offramp,
      beneficiaries: { ...beneficiaries, [beneficiary.key]: beneficiary },
    };
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
 * Registers (or reuses) an off-ramp payout beneficiary from collected bank
 * details, keyed by fiat and content hash; only a PII-light marker is stored.
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
  const audit = requestProvisioningAudit(c, input.counterparty);
  const intent = await audit.begin({
    action: "bvnk_offramp_beneficiary_registered",
    metadata: { key, fiatCurrency, accountType: beneficiary.accountType },
  });
  try {
    await persistBvnkOfframpBeneficiary(c, input.counterparty, input.projectId, beneficiary);
    await audit.complete(intent, {});
  } catch (error) {
    await audit.fail(intent, error);
    throw error;
  }
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

type BvnkStoredSessionAgreements = NonNullable<
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
 * The pre-customer stage recorded on the BVNK customer-link row.
 */
export type BvnkStoredStage =
  | {
      kind: "agreements_pending";
      sessionReference: string;
      agreements: BvnkStoredSessionAgreements;
    }
  | {
      kind: "agreements_submitted";
      sessionReference: string;
    }
  | {
      kind: "collect_counterparty";
      sessionReference: string;
      residenceCountryCode: CountryCode;
    }
  | {
      kind: "session_pending";
      residenceCountryCode: CountryCode;
    };

/**
 * Reads the pre-customer stage recorded on the BVNK customer-link row.
 *
 * @param metadata - Stored BVNK customer-link metadata.
 * @returns The pending agreements, collect, or claimed-but-unminted session step, or null.
 */
export function bvnkStoredStage(
  metadata: BvnkCustomerProviderAccountMetadata
): BvnkStoredStage | null {
  if (metadata.status !== undefined) {
    return null;
  }
  const session = metadata.session;
  if (session === undefined) {
    return {
      kind: "session_pending",
      residenceCountryCode: requireBvnkResidenceCountry(metadata),
    };
  }
  if (session.signedAt !== undefined) {
    return {
      kind: "collect_counterparty",
      sessionReference: session.reference,
      residenceCountryCode: requireBvnkResidenceCountry(metadata),
    };
  }
  if (session.consentSubmittedAt !== undefined) {
    return { kind: "agreements_submitted", sessionReference: session.reference };
  }
  return {
    kind: "agreements_pending",
    sessionReference: session.reference,
    agreements: session.agreements,
  };
}

/**
 * Presents a stored stage to the client.
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
    case "agreements_submitted":
      return { provider: "bvnk", direction, status: "counterparty_agreement_signing" };
    case "collect_counterparty":
      return bvnkCollectCounterparty(direction, stage.residenceCountryCode);
    case "session_pending":
      return bvnkResidenceRequired(direction);
    default:
      throw internalError(`Unhandled BVNK stored stage: ${String(stage satisfies never)}`);
  }
}

/**
 * Derives the client-facing BVNK requirement from stored customer-link metadata.
 *
 * @param direction - Ramp direction used in the requirement response.
 * @param metadata - Stored customer-link metadata.
 * @returns The stored stage's requirement, or null once the customer exists.
 */
export function bvnkCustomerRequirementsFromMetadata(
  direction: RampDirection,
  metadata: BvnkCustomerProviderAccountMetadata
): CounterpartyRequirements | null {
  const stage = bvnkStoredStage(metadata);
  return stage === null ? null : presentBvnkStoredStage(direction, stage);
}

/** Reads the counterparty's BVNK customer-link provider-account row. */
function readCustomerLinkRow(
  accounts: CounterpartyProviderAccountsRepository,
  counterparty: CounterpartyRow,
  projectId: string
): Promise<CounterpartyProviderAccountRow | null> {
  return accounts.getProviderAccount({
    organizationId: counterparty.organization_id,
    projectId,
    counterpartyId: counterparty.id,
    provider: "bvnk",
  });
}

/**
 * Claims, mints, and stores a BVNK agreement session for the residence
 * country claimed on the row; the session is CAS-written so a concurrent
 * mint converges on the winner, and the country is immutable once claimed.
 *
 * @param c - Request context used for provider and repository access.
 * @param input - Provider client, runtime context, counterparty, project, ramp
 * direction, and the residence country the session is minted for.
 * @returns The client-facing agreement requirement for the stored session.
 */
async function mintBvnkAgreementSession(
  c: AppContext,
  input: {
    client: typeof RAMP_PROVIDER_CLIENTS.bvnk;
    ctx: RampRuntimeContext;
    counterparty: CounterpartyRow;
    projectId: string;
    direction: RampDirection;
    residenceCountry: CountryCode;
  }
): Promise<{ requirements: CounterpartyRequirements }> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const scope = bvnkAccountScope(input.counterparty, input.projectId);
  const present = (
    metadata: BvnkCustomerProviderAccountMetadata,
    outcome: "assigned" | "converged"
  ): { requirements: CounterpartyRequirements } => {
    const stage = bvnkStoredStage(metadata);
    if (stage === null || stage.kind === "session_pending") {
      throw internalError("BVNK customer-link row has no minted session to present.");
    }
    getLogger().info(
      {
        counterparty_id: input.counterparty.id,
        session_reference: stage.sessionReference,
        outcome,
      },
      "[bvnk consent] agreement session minted"
    );
    return { requirements: presentBvnkStoredStage(input.direction, stage) };
  };

  await getCounterpartiesRepository(c).upsertBvnkCustomerProviderData({
    ...scope,
    customer: {
      customerReference: buildBvnkCustomerExternalReference(input.counterparty.id),
      residenceCountryCode: input.residenceCountry,
    },
  });
  const row = await accounts.getProviderAccount(scope);
  if (row === null) {
    throw internalError("BVNK customer-link claim produced no row.");
  }
  const claimed = bvnkCustomerProviderAccountMetadataSchema.parse(row.metadata);
  const residenceCountry = requireBvnkResidenceCountry(claimed);
  if (residenceCountry !== input.residenceCountry) {
    throw conflict("BVNK residence country is already claimed for this counterparty.", {
      residenceCountryCode: residenceCountry,
    });
  }
  if (claimed.session !== undefined) {
    return present(claimed, "converged");
  }
  const audit = requestProvisioningAudit(c, input.counterparty);
  const intent = await audit.begin({
    action: "bvnk_agreement_session_created",
    metadata: { countryCode: residenceCountry },
  });
  let assigned: Awaited<ReturnType<typeof accounts.setCustomerLinkSession>>;
  try {
    const session = await input.client.createAgreementSession(input.ctx, {
      countryCode: residenceCountry,
      idempotencyKey: counterpartyProviderAccountUuid(row.id),
    });
    assigned = await accounts.setCustomerLinkSession({
      ...scope,
      id: row.id,
      session: {
        reference: session.reference,
        agreements: toStoredSessionAgreements(session.agreements),
      },
    });
    await audit.complete(intent, { sessionReference: session.reference });
  } catch (error) {
    await audit.fail(intent, error);
    throw error;
  }
  if (assigned !== null) {
    return present(bvnkCustomerProviderAccountMetadataSchema.parse(assigned.metadata), "assigned");
  }
  const current = await accounts.getProviderAccount(scope);
  if (current === null) {
    throw internalError("BVNK customer-link row vanished underneath the session write.");
  }
  return present(bvnkCustomerProviderAccountMetadataSchema.parse(current.metadata), "converged");
}

/**
 * Moves the v1 customer reference onto the customer-link row, CAS'd against
 * the stored pre-customer alias; a lost CAS re-reads and converges on the
 * same reference, anything else is an internal error.
 *
 * @param c - Request context used for repository access.
 * @param input - Tenant scope, row id, the alias to swap from, the pre-customer metadata to keep, and the v1 customer.
 * @returns The customer resolution carried by the link row.
 */
async function assignBvnkCustomerLink(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    providerAccountId: string;
    fromProviderCustomerReference: string;
    metadata: BvnkCustomerProviderAccountMetadata;
    customer: { customerReference: string; status: string };
  }
): Promise<BvnkCustomerResolution> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const assigned = await accounts.assignCustomerLinkReference({
    ...bvnkAccountScope(input.counterparty, input.projectId),
    id: input.providerAccountId,
    fromProviderCustomerReference: input.fromProviderCustomerReference,
    providerCustomerReference: input.customer.customerReference,
    metadata: { ...input.metadata, status: input.customer.status },
  });
  const logCustomerLinkAssignment = (customerReference: string, outcome: string): void => {
    getLogger().info(
      {
        counterparty_id: input.counterparty.id,
        customer_reference: customerReference,
        outcome,
      },
      "[bvnk customer] v1 customer reference assigned to customer link"
    );
  };
  if (assigned !== null) {
    logCustomerLinkAssignment(input.customer.customerReference, "assigned");
    return input.customer;
  }
  const current = await readCustomerLinkRow(accounts, input.counterparty, input.projectId);
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
  logCustomerLinkAssignment(current.provider_customer_reference, "converged");
  return { customerReference: current.provider_customer_reference, status: metadata.status };
}

/**
 * Creates the v1 BVNK customer from the signed session's collected PII.
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
    metadata: BvnkCustomerProviderAccountMetadata;
  }
): Promise<{ customer: BvnkCustomerResolution }> {
  const audit = requestProvisioningAudit(c, input.counterparty);
  const intent = await audit.begin({
    action: "bvnk_customer_created",
    metadata: { reference: input.reference },
  });
  try {
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
      metadata: input.metadata,
      customer: { customerReference: created.reference, status: created.status },
    });
    await audit.complete(intent, {
      customerReference: created.reference ?? null,
      status: created.status ?? null,
    });
    return { customer };
  } catch (error) {
    await audit.fail(intent, error);
    throw error;
  }
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
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const link = await readCustomerLinkRow(accounts, counterparty, counterparty.project_id);
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
 * Refreshes the v1 customer from BVNK by its stored reference, patching
 * status and verification status onto the customer-link row.
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
  const verificationStatus = latest.verification?.status;
  const set: BvnkCustomerProviderAccountMetadata = {
    status: latest.status,
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
  };
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const updated = await accounts.patchAccountMetadata({
    ...bvnkAccountScope(input.counterparty, input.projectId),
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
    verificationUrl: latest.verification?.url,
  };
}

/**
 * Presents the stored pre-customer stage of a customer-link row.
 *
 * @param direction - Ramp direction used in the requirement response.
 * @param metadata - Stored customer-link metadata to derive the stage from.
 * @param context - Message naming the write that expected a pre-customer stage.
 * @returns The client-facing requirement for the stored stage.
 */
function presentBvnkStoredMetadata(
  direction: RampDirection,
  metadata: Record<string, unknown>,
  context: string
): { requirements: CounterpartyRequirements } {
  const stage = bvnkStoredStage(bvnkCustomerProviderAccountMetadataSchema.parse(metadata));
  if (stage === null) {
    throw internalError(`${context} produced no stored stage.`);
  }
  return { requirements: presentBvnkStoredStage(direction, stage) };
}

/**
 * Signs the stored agreement session at BVNK with the consenting user's IP,
 * CAS-recording `session.consentSubmittedAt`.
 *
 * @param c - Request context used for the client IP and repository access.
 * @param input - Provider client, runtime context, counterparty, project, ramp
 * direction, customer-link row id, and the session being consented to.
 * @returns The client-facing requirement for the row's stage after consent.
 */
async function recordBvnkAgreementConsent(
  c: AppContext,
  input: {
    client: typeof RAMP_PROVIDER_CLIENTS.bvnk;
    ctx: RampRuntimeContext;
    counterparty: CounterpartyRow;
    projectId: string;
    direction: RampDirection;
    providerAccountId: string;
    sessionReference: string;
  }
): Promise<{ requirements: CounterpartyRequirements }> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const scope = bvnkAccountScope(input.counterparty, input.projectId);
  const ipAddress = getClientIp(c);
  const consentIp = ipAddress === null ? BVNK_UNRESOLVED_CONSENT_IP : ipAddress;
  const audit = requestProvisioningAudit(c, input.counterparty);
  const intent = await audit.begin({
    action: "bvnk_agreement_session_signed",
    metadata: { sessionReference: input.sessionReference, consentIp },
  });
  let consentSubmittedAt: string;
  let updated: Awaited<ReturnType<typeof accounts.markCustomerLinkSessionTimestamp>>;
  try {
    await input.client.signAgreementSession(input.ctx, {
      reference: input.sessionReference,
      ipAddress: consentIp,
    });
    consentSubmittedAt = new Date().toISOString();
    updated = await accounts.markCustomerLinkSessionTimestamp({
      ...scope,
      id: input.providerAccountId,
      sessionReference: input.sessionReference,
      field: "consentSubmittedAt",
      timestamp: consentSubmittedAt,
    });
    await audit.complete(intent, { consentSubmittedAt });
  } catch (error) {
    await audit.fail(intent, error);
    throw error;
  }
  if (updated !== null) {
    getLogger().info(
      {
        counterparty_id: input.counterparty.id,
        session_reference: input.sessionReference,
        consent_submitted_at: consentSubmittedAt,
      },
      "[bvnk consent] agreement session consent submitted"
    );
    return presentBvnkStoredMetadata(
      input.direction,
      updated.metadata,
      "BVNK agreement consent update"
    );
  }
  const current = await accounts.getProviderAccount(scope);
  if (current === null) {
    throw internalError("BVNK agreement consent CAS lost its customer-link row.");
  }
  return presentBvnkStoredMetadata(input.direction, current.metadata, "BVNK agreement consent CAS");
}

/**
 * Advances the BVNK customer lifecycle: mints the agreement session, signs it
 * on consent, creates the v1 customer from the collected PII pack, or
 * refreshes the stored customer from BVNK.
 *
 * @param c - Request context used for provider and repository access.
 * @param counterparty - Counterparty whose provider state is resolved.
 * @param projectId - Project that owns the counterparty.
 * @param direction - Ramp direction used when returning an intermediate requirement.
 * @param collectedData - Residence country on the first step; the full PII pack once
 *   signed — only the residence country is stored, never the PII pack.
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
  const existing = await readCustomerLinkRow(accounts, counterparty, projectId);

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
          metadata,
        });
      }
      if (stage.kind === "agreements_pending" && agreementConsent !== undefined) {
        return recordBvnkAgreementConsent(c, {
          client,
          ctx,
          counterparty,
          projectId,
          direction,
          providerAccountId: existing.id,
          sessionReference: stage.sessionReference,
        });
      }
      if (stage.kind === "session_pending" && collectedData !== undefined) {
        return mintBvnkAgreementSession(c, {
          client,
          ctx,
          counterparty,
          projectId,
          direction,
          residenceCountry: parseBvnkResidenceCountry(collectedData),
        });
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
  return mintBvnkAgreementSession(c, {
    client,
    ctx,
    counterparty,
    projectId,
    direction,
    residenceCountry: parseBvnkResidenceCountry(collectedData),
  });
}

/** Reads the counterparty's per-fiat BVNK funding-wallet row. */
async function readFundingWalletRow(
  accounts: CounterpartyProviderAccountsRepository,
  scope: GetCounterpartyProviderAccountInput,
  fiatCurrency: string
): Promise<CounterpartyProviderAccountRow | null> {
  return accounts.getAccountByKindAndCurrency({ ...scope, kind: "funding_wallet", fiatCurrency });
}

/** CAS-assigns the funding reference onto the claimed row, re-reading on a lost CAS. */
async function assignFundingWalletReferenceOrReadBack(
  accounts: CounterpartyProviderAccountsRepository,
  scope: GetCounterpartyProviderAccountInput,
  row: CounterpartyProviderAccountRow,
  fiatCurrency: string,
  walletId: string,
  divergedFrom: string,
  assignedLogMessage?: string
): Promise<CounterpartyProviderAccountRow> {
  const assigned = await accounts.assignFundingWalletReference({
    ...scope,
    id: row.id,
    externalAccountReference: walletId,
  });
  if (assigned !== null) {
    if (assignedLogMessage !== undefined) {
      getLogger().info(
        {
          provider_account_id: assigned.id,
          wallet_id: walletId,
          fiat_currency: fiatCurrency,
        },
        assignedLogMessage
      );
    }
    return assigned;
  }
  const current = await readFundingWalletRow(accounts, scope, fiatCurrency);
  if (current === null || current.external_account_reference !== walletId) {
    throw internalError(`BVNK funding wallet reference diverged from the ${divergedFrom} wallet.`);
  }
  return current;
}

/**
 * Adopts an existing BVNK funding wallet for the claimed row: the wallet list
 * was queried by customer and currency, so the name is matched locally and
 * validated per match; more than one fails loudly, exactly one is CAS-assigned.
 *
 * @param accounts - The counterparty provider-account repository.
 * @param scope - Tenant scope of the funding row.
 * @param row - The claimed funding-wallet row the reference is assigned to.
 * @param customerLink - The verified customer-link row carrying the provider customer reference.
 * @param fiatCurrency - The fiat currency the wallet was provisioned for.
 * @param walletName - The deterministic SDP wallet name to match locally.
 * @param wallets - Every wallet BVNK returned for the customer and currency.
 * @returns The row carrying the adopted wallet reference, or null to proceed to create.
 */
async function adoptBvnkFundingWalletByName(
  accounts: CounterpartyProviderAccountsRepository,
  scope: GetCounterpartyProviderAccountInput,
  row: CounterpartyProviderAccountRow,
  customerLink: CounterpartyProviderAccountRow,
  fiatCurrency: string,
  walletName: string,
  wallets: BvnkV2WalletListRow[]
): Promise<CounterpartyProviderAccountRow | null> {
  const namedMatches = wallets.filter((wallet) => wallet.name === walletName);
  for (const wallet of namedMatches) {
    const walletCurrency = wallet.balance === undefined ? null : wallet.balance.currency;
    if (
      wallet.customer.id !== customerLink.provider_customer_reference ||
      walletCurrency !== fiatCurrency
    ) {
      throw internalError(
        `BVNK funding wallet ${wallet.id} is not the ${fiatCurrency} funding wallet of the customer link`
      );
    }
  }
  if (namedMatches.length > 1) {
    const walletIds = namedMatches.map((wallet) => wallet.id).join(", ");
    throw internalError(
      `BVNK funding wallet name ${walletName} is held by multiple wallets: ${walletIds}`
    );
  }
  if (namedMatches.length === 0) {
    return null;
  }
  const wallet = namedMatches[0];
  return assignFundingWalletReferenceOrReadBack(
    accounts,
    scope,
    row,
    fiatCurrency,
    wallet.id,
    "adopted",
    "[bvnk] funding wallet adopted by customer and currency"
  );
}

/**
 * Claims the per-fiat funding-wallet row, then creates or adopts the BVNK
 * funding wallet, CAS-writing the reference onto the claimed row.
 *
 * @param env - Process environment used for repository access.
 * @param ctx - Ramp runtime context used for provider access.
 * @param input.counterparty - Counterparty whose funding wallet is provisioned.
 * @param input.projectId - Project that owns the counterparty.
 * @param input.customerLink - Verified BVNK customer-link row carrying the provider customer reference.
 * @param input.fiatCurrency - Fiat currency the funding wallet is provisioned for.
 * @param input.audit - Provisioning audit admitting the wallet creation intent.
 * @returns The claimed funding-wallet row carrying the created or adopted wallet reference.
 */
export async function ensureBvnkFundingWallet(
  env: Env,
  ctx: RampRuntimeContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    customerLink: CounterpartyProviderAccountRow;
    fiatCurrency: RampFiatCurrency;
    audit: BvnkProvisioningAudit;
  }
): Promise<CounterpartyProviderAccountRow> {
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const scope = bvnkAccountScope(input.counterparty, input.projectId);
  const claimed = await accounts.claimFundingWallet({
    ...scope,
    providerCustomerReference: input.customerLink.provider_customer_reference,
    fiatCurrency: input.fiatCurrency,
    providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
  });
  let row = claimed;
  if (row === null) {
    const existing = await readFundingWalletRow(accounts, scope, input.fiatCurrency);
    if (existing === null) {
      throw internalError("BVNK funding wallet claim conflicted with no active row.");
    }
    if (existing.external_account_reference !== null) {
      return existing;
    }
    if (Date.now() - Date.parse(existing.updated_at) < BVNK_FUNDING_WALLET_CLAIM_TAKEOVER_MS) {
      throw internalError(`BVNK funding wallet ${existing.id} creation is in flight`);
    }
    const leased = await accounts.leaseStaleFundingWalletClaim({
      ...scope,
      id: existing.id,
      cutoff: new Date(Date.now() - BVNK_FUNDING_WALLET_CLAIM_TAKEOVER_MS).toISOString(),
    });
    if (leased === null) {
      throw internalError(`BVNK funding wallet ${existing.id} creation is in flight`);
    }
    row = leased;
  }
  const walletName = buildBvnkFundingWalletName(input.customerLink.id);
  const existingWallets = await client.listLedgerWalletsV2(ctx, {
    customerId: input.customerLink.provider_customer_reference,
    currency: input.fiatCurrency,
  });
  const adopted = await adoptBvnkFundingWalletByName(
    accounts,
    scope,
    row,
    input.customerLink,
    input.fiatCurrency,
    walletName,
    existingWallets.content
  );
  if (adopted !== null) {
    return adopted;
  }
  const profiles = await client.listLedgerWalletProfilesV2(ctx, {
    customerId: input.customerLink.provider_customer_reference,
    currency: input.fiatCurrency,
  });
  const profile = selectBvnkWalletProfile(profiles, input.fiatCurrency);
  const intent = await input.audit.begin({
    action: "bvnk_funding_wallet_created",
    metadata: { walletName, fiatCurrency: input.fiatCurrency, providerAccountId: row.id },
  });
  let wallet: BvnkLedgerWalletV2;
  try {
    wallet = await client.createLedgerWalletV2(ctx, {
      customerId: input.customerLink.provider_customer_reference,
      name: walletName,
      currency: input.fiatCurrency,
      profileId: profile.id,
      idempotencyKey: await buildBvnkWalletIdempotencyKey(walletName),
    });
    if (wallet.name !== walletName) {
      throw internalError(`BVNK returned unexpected funding wallet name: ${wallet.name}`);
    }
  } catch (error) {
    await input.audit.fail(intent, error);
    throw error;
  }
  row = await assignFundingWalletReferenceOrReadBack(
    accounts,
    scope,
    row,
    input.fiatCurrency,
    wallet.id,
    "created"
  );
  await input.audit.complete(intent, { walletId: wallet.id });
  getLogger().info(
    {
      counterparty_id: input.counterparty.id,
      provider_account_id: row.id,
      wallet_id: wallet.id,
      fiat_currency: input.fiatCurrency,
    },
    "[bvnk] funding wallet provisioned"
  );
  return row;
}

/**
 * Builds the BVNK on-ramp quote for a prebooked transfer: reads the
 * provisioned funding wallet, fetches its bank details JIT, and mints the
 * funding instructions; the status CAS to awaiting_payment is the last
 * fallible step.
 *
 * @param c - Request context used for repository access.
 * @param input.counterparty - Counterparty whose funding wallet funds the transfer.
 * @param input.projectId - Project that owns the counterparty.
 * @param input.transferId - Prebooked transfer id the payment reference is minted from.
 * @param input.network - Crypto network the funded fiat converts into.
 * @param input.currency - Crypto currency the funded fiat converts into.
 * @param input.destinationWalletAddress - Address receiving the converted crypto.
 * @param input.fiatCurrency - Fiat currency of the funding wallet and deposit.
 * @returns The BVNK on-ramp quote with its funding instructions.
 */
export async function bvnkOnrampQuote(
  c: AppContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    transferId: string;
    network: string;
    currency: string;
    destinationWalletAddress: string;
    fiatCurrency: RampFiatCurrency;
  }
): Promise<{ quote: BvnkOnrampQuote }> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const scope = bvnkAccountScope(input.counterparty, input.projectId);
  try {
    const ctx = rampRuntime(c);
    const row = await readFundingWalletRow(accounts, scope, input.fiatCurrency);
    if (
      row === null ||
      row.provider_status !== BVNK_FUNDING_WALLET_STATUS.provisioned ||
      row.external_account_reference === null
    ) {
      throw counterpartyNotProvisioned("bvnk", "onramp", {
        fundingWalletStatus: row === null ? null : row.provider_status,
      });
    }
    const walletId = row.external_account_reference;
    const wallet = await RAMP_PROVIDER_CLIENTS.bvnk.getLedgerWalletV2(ctx, { walletId });
    const bankAccount = bvnkWalletBankAccount(wallet);
    if (bankAccount === undefined) {
      throw internalError("BVNK funding wallet has no fiat payment instrument yet.");
    }
    const paymentReference = bvnkOnrampRemittance(input.transferId);
    const instruction: BvnkFiatFundingInstruction = {
      provider: "bvnk",
      kind: "fiat_funding",
      onboardingStatus: "ready",
      fundingWalletId: walletId,
      fiatCurrency: input.fiatCurrency,
      beneficiaryAddress: input.destinationWalletAddress,
      network: input.network,
      bankAccount,
      paymentReference,
      ...(bankAccount.paymentReference === undefined
        ? {}
        : { remittanceInformationPrefix: bankAccount.paymentReference }),
      instructionsNotes: `Include ${paymentReference} in the bank transfer reference to receive crypto on ${input.network}.`,
    };
    const updated = await getPaymentsRepository(c).updateTransferStatusGuarded({
      transferId: input.transferId,
      organizationId: input.counterparty.organization_id,
      projectId: input.projectId,
      fromStatuses: ["pending"],
      toStatus: "awaiting_payment",
      updatedAt: new Date().toISOString(),
    });
    if (updated === null) {
      throw internalError("BVNK on-ramp transfer left pending before the quote completed.");
    }
    getLogger().info(
      {
        counterparty_id: input.counterparty.id,
        transfer_id: input.transferId,
        provider_account_id: row.id,
        wallet_id: walletId,
      },
      "[bvnk onramp] quote issued awaiting_payment funding instructions"
    );
    return {
      quote: {
        provider: "bvnk",
        id: rampId("bvnk_onramp"),
        status: "pending",
        deliveryMode: "manual_instructions",
        paymentInstructions: [instruction],
      },
    };
  } catch (error) {
    await getPaymentsRepository(c).updateTransferStatusGuarded({
      transferId: input.transferId,
      organizationId: input.counterparty.organization_id,
      projectId: input.projectId,
      fromStatuses: ["pending"],
      toStatus: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}

/**
 * The SINGLE request builder for the BVNK on-ramp payout converting a settled
 * pay-in into crypto: the first attempt and every recovery reissue call it,
 * so a recovery spends exactly the claim's validated intent.
 *
 * @param input.transferId - The transfer id, used as the provider payout reference.
 * @param input.bvnkCustomer - Typed BVNK v1 customer whose details become the payout party details.
 * @param input.customerId - The BVNK customer reference of the funding wallet owner.
 * @param input.fundingWalletReference - BVNK ledger wallet id the payout debits.
 * @param input.intent - The validated spend intent persisted at claim time.
 * @returns The request body for {@link createOnrampPayout}.
 */
export function buildBvnkOnrampPayout(input: {
  transferId: string;
  bvnkCustomer: BvnkCustomer;
  customerId: string;
  fundingWalletReference: string;
  intent: BvnkOnrampPayoutIntent;
}): BvnkOnrampPayoutInput {
  return {
    walletId: input.fundingWalletReference,
    amount: toNumberAmount(input.intent.amount),
    currency: input.intent.currency,
    reference: input.transferId,
    customerId: input.customerId,
    payOutDetails: {
      code: "crypto",
      currency: input.intent.cryptoCurrency,
      network: BVNK_PAYOUT_NETWORK.create,
      address: input.intent.address,
    },
    complianceDetails: {
      requesterIpAddress: "0.0.0.0",
      partyDetails: [bvnkPayoutPartyDetailsFromCustomer(input.bvnkCustomer)],
    },
  };
}

/**
 * Recovers a stale provisioning row whose BVNK wallet already exists: reads
 * the wallet and CAS-advances the row to `provisioned` once it is ACTIVE with
 * a FIAT payment instrument.
 *
 * @param env - Process environment used for repository access.
 * @param ctx - Ramp runtime context used for provider access.
 * @param input.counterparty - Counterparty that owns the funding row.
 * @param input.projectId - Project that owns the counterparty.
 * @param input.fundingRow - Stale provisioning funding-wallet row carrying a wallet reference.
 * @returns Resolves once recovery read the wallet and attempted the CAS.
 */
export async function recoverProvisioningBvnkFundingWallet(
  env: Env,
  ctx: RampRuntimeContext,
  input: {
    counterparty: CounterpartyRow;
    projectId: string;
    fundingRow: CounterpartyProviderAccountRow;
  }
): Promise<void> {
  const walletId = input.fundingRow.external_account_reference;
  if (walletId === null) {
    return;
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const scope = bvnkAccountScope(input.counterparty, input.projectId);
  const wallet = await RAMP_PROVIDER_CLIENTS.bvnk.getLedgerWalletV2(ctx, { walletId });
  const hasFiatInstrument =
    wallet.paymentInstruments === undefined
      ? false
      : wallet.paymentInstruments.some(
          (instrument) => instrument.type === "FIAT" && instrument.accountNumber.length > 0
        );
  if (wallet.status !== "ACTIVE" || !hasFiatInstrument) {
    return;
  }
  await accounts.updateFundingWalletStatus({
    ...scope,
    id: input.fundingRow.id,
    fromStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
    toStatus: BVNK_FUNDING_WALLET_STATUS.provisioned,
  });
}

/**
 * Derives the client-facing BVNK on-ramp requirement from the funding-wallet
 * row: the provisioning gate while missing or `provisioning`, null once
 * provisioned, and a loud failure otherwise. Off-ramp never consults it.
 *
 * @param c - Request context used for repository access.
 * @param input.counterparty - Counterparty whose funding wallet is gated.
 * @param input.projectId - Project that owns the counterparty.
 * @param input.direction - Ramp direction being gated.
 * @returns The funding-wallet requirement, or null when the caller can answer `ready`.
 */
export async function bvnkFundingWalletRequirements(
  c: AppContext,
  input: { counterparty: CounterpartyRow; projectId: string; direction: RampDirection }
): Promise<CounterpartyRequirements | null> {
  if (input.direction === "offramp") {
    return null;
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const scope = bvnkAccountScope(input.counterparty, input.projectId);
  const row = await readFundingWalletRow(accounts, scope, BVNK_FUNDING_WALLET_FIAT);
  if (row === null || row.provider_status === BVNK_FUNDING_WALLET_STATUS.provisioning) {
    return {
      provider: "bvnk",
      direction: input.direction,
      status: "customer_funding_account_provisioning",
    };
  }
  if (row.provider_status === BVNK_FUNDING_WALLET_STATUS.provisioned) {
    return null;
  }
  throw internalError(`BVNK funding wallet is in unresolvable status: ${row.provider_status}.`);
}

/**
 * The provider-side payout reference the transfer API presents for a BVNK
 * row: an on-ramp presents the crypto payout uuid once a stored settlement
 * records it (the stored reference is the SDP transfer id), and omits the
 * field before that; other BVNK rows keep the stored reference as-is.
 *
 * @param row - The payment transfer row being mapped.
 * @returns The payout uuid, the stored reference, or undefined when the on-ramp has no payout yet.
 */
export function bvnkProviderReference(row: PaymentTransferRow): string | undefined {
  if (row.type !== "onramp") {
    return row.provider_reference === null ? undefined : row.provider_reference;
  }
  const stored = readStoredBvnkSettlement(row.provider_data);
  if (stored.outcome === "malformed") {
    throw internalError(`BVNK on-ramp transfer ${row.id} has a malformed stored settlement.`);
  }
  return stored.outcome === "present" ? stored.settlement.payoutId : undefined;
}
