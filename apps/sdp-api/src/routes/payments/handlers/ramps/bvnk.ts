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
  type BvnkCustomerResolution,
  type BvnkOfframpBeneficiary,
  type BvnkOfframpWallet,
  buildBvnkCustomerExternalReference,
  buildBvnkFundingWalletName,
  buildBvnkOfframpWalletName,
  buildBvnkWalletIdempotencyKey,
  bvnkRuleEntityFromCustomer,
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
  BvnkCustomerIndividual,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletProfileV2,
  BvnkLedgerWalletV2,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import { isBvnkRuleActive } from "@sdp/payments/ramps/providers/bvnk/schemas";
import { buildRequirementSchema } from "@sdp/payments/ramps/requirements";
import { rampId } from "@sdp/payments/ramps/shared";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type {
  BvnkBankFundingDetails,
  BvnkFiatFundingInstruction,
  BvnkPaymentRampInstruction,
  CountryCode,
  CryptoRailId,
  PaymentRampQuote,
} from "@sdp/types";
import { BVNK_FUNDING_WALLET_STATUS, isTerminalRampTransferStatus } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type {
  BvnkReservedTransfer,
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { getDb } from "@/db";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import {
  type BvnkCustomerProviderAccountMetadata,
  bvnkCustomerProviderAccountMetadataSchema,
  bvnkFundingWalletLockSchema,
  type CounterpartyProviderAccountRow,
  counterpartyProviderAccountUuid,
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
  complete(intent: AuditIntent, metadata: Record<string, unknown>): Promise<void>;
  /** Resolves the intent with a failure outcome, so a routine provider error
   * does not strand an unresolved intent that pollutes ledger verification.
   * The outcome records that the ATTEMPT failed, never that the provider-side
   * object does not exist: an ambiguous error (a timeout after the provider
   * accepted the call) may have created it, so the entry carries
   * providerOutcome: "unverified" instead of asserting a definite state. */
  fail(intent: AuditIntent, error: unknown): Promise<void>;
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
 * Reads the pre-customer stage recorded on the BVNK customer-link row without
 * any provider call, so callers can gate or branch on it before deciding
 * whether the stage is actually presented to the client.
 *
 * @param metadata - Stored BVNK customer-link metadata.
 * @returns The pending agreements, the collect step, the claimed-but-unminted
 * session step, or null once the customer exists.
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
    return {
      kind: "agreements_submitted",
      sessionReference: session.reference,
    };
  }
  return {
    kind: "agreements_pending",
    sessionReference: session.reference,
    agreements: session.agreements,
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
    case "agreements_submitted":
      return {
        provider: "bvnk",
        direction,
        status: "counterparty_agreement_signing",
      };
    case "collect_counterparty":
      return bvnkCollectCounterparty(direction, stage.residenceCountryCode);
    case "session_pending":
      return bvnkResidenceRequired(direction);
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
 * Claims, mints, and stores a BVNK agreement session for a residence country.
 * The row reservation is claimed before the provider call and the minted
 * session is CAS-written onto it, so a concurrent mint either loses the CAS
 * and converges on the winner's session, or a crash leaves a claimed row that
 * the next residence submit mints from. The residence country is immutable
 * once claimed: the session is always minted for the stored country, and a
 * submit naming a different country is rejected before any provider call.
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
  const scope = {
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk" as const,
  };
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
  // The agreement session is the provider-side consent artifact this
  // counterparty will sign; its creation is admitted intent/outcome like the
  // other BVNK provisioning steps.
  const audit = requestProvisioningAudit(c, input.counterparty);
  const intent = await audit.begin({
    action: "bvnk_agreement_session_created",
    metadata: { countryCode: residenceCountry },
  });
  // The catch covers only the effect and its durable write: everything after
  // `complete` runs outside it, so one intent can never collect a success
  // outcome and then a contradicting failure outcome from the read-back path.
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
 * Moves the v1 customer reference onto the customer-link row with a
 * compare-and-swap against the stored pre-customer alias, keeping the
 * residence country and signed session and adding `status`. A lost CAS means a concurrent create
 * already assigned the reference, so the row is re-read: the concurrent
 * assignment of the same reference converges, anything else is an internal
 * error.
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
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk",
    id: input.providerAccountId,
    fromProviderCustomerReference: input.fromProviderCustomerReference,
    providerCustomerReference: input.customer.customerReference,
    metadata: { ...input.metadata, status: input.customer.status },
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
    metadata: BvnkCustomerProviderAccountMetadata;
  }
): Promise<{ customer: BvnkCustomerResolution }> {
  // Creating the provider customer binds this counterparty's KYC identity at
  // BVNK; the intent precedes the call, the outcome carries the assigned
  // reference.
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
 * bvnkCustomerStatusRequirements enforces.
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
 * Signs the stored agreement session at BVNK with the consenting user's IP and
 * CAS-records `session.consentSubmittedAt` without touching a `signedAt` the
 * status webhook may already have written. A lost CAS means a concurrent
 * consent already recorded it, so the row is re-read and its stage presented.
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
  const scope = {
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk" as const,
  };
  const ipAddress = getClientIp(c);
  const consentIp = ipAddress === null ? BVNK_UNRESOLVED_CONSENT_IP : ipAddress;
  // Signing registers the consent (and its IP) with the provider — a legal
  // state change admitted intent/outcome like the other provisioning steps.
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
 *   once the session is signed. Only the residence country is stored (the
 *   claim); the PII pack is never persisted.
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

/**
 * Claims the per-fiat customer funding wallet row and creates the BVNK wallet
 * for a verified customer. Claim-before-spend: the INSERT on the partial
 * unique index decides the race, the wallet is created only after the row
 * exists, and the wallet id is CAS-written onto the row
 * `WHERE external_account_reference IS NULL`. A lost CAS re-reads the row: a
 * reference equal to the created wallet id is the converged outcome of a
 * concurrent provisioning, anything else fails loudly and nothing is
 * overwritten. BVNK does not deduplicate concurrent creates under one
 * idempotency key, so a claimed row whose reference has not landed is treated
 * as creation in flight until BVNK_FUNDING_WALLET_CLAIM_TAKEOVER_MS passes:
 * the webhook parks and replay retries once the reference lands. Only a claim
 * older than the window is taken over as a crashed claimer, using the
 * name-hashed idempotency key as a non-concurrent retry that BVNK does dedupe.
 *
 * @param env - Process environment used for repository access.
 * @param ctx - Ramp runtime context used for provider access.
 * @param input - Counterparty, project, the verified customer-link row, the
 * fiat currency to provision, and the provisioning audit.
 * @returns The claimed funding-wallet row carrying the created wallet reference.
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
  const scope = {
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk" as const,
  };
  const claimed = await accounts.claimFundingWallet({
    ...scope,
    providerCustomerReference: input.customerLink.provider_customer_reference,
    fiatCurrency: input.fiatCurrency,
    providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
  });
  let row: CounterpartyProviderAccountRow;
  if (claimed === null) {
    const existing = await accounts.getAccountByKindAndCurrency({
      ...scope,
      kind: "funding_wallet",
      fiatCurrency: input.fiatCurrency,
    });
    if (existing === null) {
      throw internalError("BVNK funding wallet claim conflicted with no active row.");
    }
    if (existing.external_account_reference !== null) {
      return existing;
    }
    if (Date.now() - Date.parse(existing.updated_at) < BVNK_FUNDING_WALLET_CLAIM_TAKEOVER_MS) {
      throw internalError(`BVNK funding wallet ${existing.id} creation is in flight`);
    }
    row = existing;
  } else {
    row = claimed;
  }
  const walletName = buildBvnkFundingWalletName(input.customerLink.id);
  const profile = selectBvnkWalletProfile(
    await client.listLedgerWalletProfilesV2(ctx, {
      customerId: input.customerLink.provider_customer_reference,
      currency: input.fiatCurrency,
    }),
    input.fiatCurrency
  );
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
  const assigned = await accounts.assignFundingWalletReference({
    ...scope,
    id: row.id,
    externalAccountReference: wallet.id,
  });
  if (assigned === null) {
    const current = await accounts.getAccountByKindAndCurrency({
      ...scope,
      kind: "funding_wallet",
      fiatCurrency: input.fiatCurrency,
    });
    if (current === null || current.external_account_reference !== wallet.id) {
      throw internalError("BVNK funding wallet reference diverged from the created wallet.");
    }
    row = current;
  } else {
    row = assigned;
  }
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
 * Deactivates every ACTIVE payment rule on a wallet, optionally only the
 * rules whose reference matches one transfer. This is the single source of
 * truth for rule teardown: SDP stores no rule id, so the wallet's rule list
 * decides which rules to deactivate.
 *
 * @param ctx - Ramp runtime context used for provider access.
 * @param input - The wallet to weed, and the transfer id to restrict the teardown to.
 * @returns The number of rules deactivated.
 */
export async function deactivateBvnkRules(
  ctx: RampRuntimeContext,
  input: { walletId: string; transferId?: string }
): Promise<number> {
  const rules = await RAMP_PROVIDER_CLIENTS.bvnk.listOnrampRules(ctx, {
    walletId: input.walletId,
  });
  const active = rules.filter(
    (rule) =>
      isBvnkRuleActive(rule.status) &&
      (input.transferId === undefined || rule.reference === input.transferId)
  );
  for (const rule of active) {
    await RAMP_PROVIDER_CLIENTS.bvnk.deactivateOnrampRule(ctx, { ruleId: rule.id });
  }
  return active.length;
}

/**
 * Builds and locks the BVNK on-ramp quote: weeds stale rules, creates the
 * per-transfer payment rule, and returns the funding instructions. The quote
 * holds the funding wallet lock until the pay-in settles or the client
 * cancels; every failure path releases the lock and fails the prebooked
 * transfer before the original error travels on.
 *
 * @param c - Request context used for repository access.
 * @param input - Counterparty, project, the prebooked transfer id, and the quote's currency and destination fields.
 * @returns The BVNK on-ramp quote with its funding instructions.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the funding-wallet lock CAS, stale-lock release, and rule provisioning must stay in one explicit order.
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
  const scope = {
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk" as const,
  };
  const row = await accounts.getAccountByKindAndCurrency({
    ...scope,
    kind: "funding_wallet",
    fiatCurrency: input.fiatCurrency,
  });
  if (
    row === null ||
    (row.provider_status !== BVNK_FUNDING_WALLET_STATUS.provisioned &&
      row.provider_status !== BVNK_FUNDING_WALLET_STATUS.locked)
  ) {
    throw counterpartyNotProvisioned("bvnk", "onramp", {
      fundingWalletStatus: row === null ? null : row.provider_status,
    });
  }
  if (row.external_account_reference === null) {
    throw counterpartyNotProvisioned("bvnk", "onramp", {
      fundingWalletStatus: row.provider_status,
    });
  }
  const walletId = row.external_account_reference;
  const failPrebooked = async (error: string): Promise<void> => {
    await getPaymentsRepository(c).updateTransferStatusGuarded({
      transferId: input.transferId,
      organizationId: input.counterparty.organization_id,
      projectId: input.projectId,
      fromStatuses: ["pending"],
      toStatus: "failed",
      error,
      updatedAt: new Date().toISOString(),
    });
  };
  let locked = await accounts.lockFundingWallet({
    ...scope,
    id: row.id,
    transferId: input.transferId,
  });
  if (locked === null) {
    const current = await accounts.getAccountByKindAndCurrency({
      ...scope,
      kind: "funding_wallet",
      fiatCurrency: input.fiatCurrency,
    });
    if (current === null || current.external_account_reference === null) {
      throw internalError("BVNK funding wallet row vanished underneath the lock.");
    }
    let blockingTransferId: string | null = null;
    if (current.provider_status === BVNK_FUNDING_WALLET_STATUS.locked) {
      const lockMetadata = bvnkFundingWalletLockSchema.parse(current.metadata);
      blockingTransferId = lockMetadata.transferId;
      const holding = await getPaymentsRepository(c).getTransferById({
        transferId: lockMetadata.transferId,
        organizationId: input.counterparty.organization_id,
        projectId: input.projectId,
      });
      if (holding === null || isTerminalRampTransferStatus(holding.status)) {
        await deactivateBvnkRules(rampRuntime(c), {
          walletId: current.external_account_reference,
          transferId: lockMetadata.transferId,
        });
        await accounts.releaseFundingWallet({
          ...scope,
          id: current.id,
          transferId: lockMetadata.transferId,
        });
        locked = await accounts.lockFundingWallet({
          ...scope,
          id: current.id,
          transferId: input.transferId,
        });
      }
    }
    if (locked === null) {
      const message =
        blockingTransferId === null
          ? "BVNK funding wallet is not available for a new quote."
          : `BVNK funding wallet is reserved by transfer ${blockingTransferId}.`;
      await failPrebooked(
        blockingTransferId === null ? message : `funding wallet reserved by ${blockingTransferId}`
      );
      throw conflict(
        message,
        blockingTransferId === null ? undefined : { transferId: blockingTransferId }
      );
    }
  }
  try {
    await deactivateBvnkRules(rampRuntime(c), { walletId });
    const audit = requestProvisioningAudit(c, input.counterparty);
    const intent = await audit.begin({
      action: "bvnk_onramp_payment_rule_created",
      metadata: { transferId: input.transferId, walletId },
    });
    try {
      const latest = await RAMP_PROVIDER_CLIENTS.bvnk.getCustomer(rampRuntime(c), {
        reference: row.provider_customer_reference,
      });
      const rule = await RAMP_PROVIDER_CLIENTS.bvnk.createOnrampRule(rampRuntime(c), {
        reference: input.transferId,
        walletId,
        currency: input.currency,
        network: input.network,
        beneficiaryAddress: input.destinationWalletAddress,
        entity: bvnkRuleEntityFromCustomer(latest),
      });
      await audit.complete(intent, { ruleId: rule.id });
    } catch (error) {
      await audit.fail(intent, error);
      throw error;
    }
    const wallet = await RAMP_PROVIDER_CLIENTS.bvnk.getLedgerWalletV2(rampRuntime(c), {
      walletId,
    });
    const bankAccount = bvnkWalletBankAccount(wallet);
    if (bankAccount === undefined) {
      throw internalError("BVNK funding wallet has no fiat payment instrument yet.");
    }
    const instruction: BvnkFiatFundingInstruction = {
      provider: "bvnk",
      kind: "fiat_funding",
      onboardingStatus: "ready",
      fundingWalletId: walletId,
      fiatCurrency: input.fiatCurrency,
      beneficiaryAddress: input.destinationWalletAddress,
      network: input.network,
      bankAccount,
      instructionsNotes: `Fund your ${input.fiatCurrency} BVNK virtual account to receive crypto on ${input.network}.`,
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
      "[bvnk onramp] quote locked the funding wallet and created its payment rule"
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
    await accounts.releaseFundingWallet({ ...scope, id: row.id, transferId: input.transferId });
    await failPrebooked(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Derives the client-facing BVNK on-ramp requirement from the funding wallet
 * row after the customer is verified: the provisioning gate while BVNK has no
 * active wallet, the reserved/settling gate while a quote holds the lock, and
 * a null answer (the caller answers `ready`) once the wallet is provisioned.
 * A lock whose transfer is terminal or gone is released inline so the next
 * quote can reclaim the wallet. Off-ramp never consults the funding wallet.
 *
 * @param c - Request context used for repository access.
 * @param input - Counterparty, project, and the ramp direction being gated.
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
  const scope = {
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk" as const,
  };
  const row = await accounts.getAccountByKindAndCurrency({
    ...scope,
    kind: "funding_wallet",
    fiatCurrency: BVNK_FUNDING_WALLET_FIAT,
  });
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
  if (row.provider_status !== BVNK_FUNDING_WALLET_STATUS.locked) {
    throw internalError(
      `BVNK funding wallet is in unresolvable status: ${String(row.provider_status)}.`
    );
  }
  if (row.external_account_reference === null) {
    throw internalError("BVNK funding wallet lock has no wallet reference.");
  }
  const walletId = row.external_account_reference;
  const lockMetadata = bvnkFundingWalletLockSchema.parse(row.metadata);
  const releaseStaleLock = async (): Promise<CounterpartyRequirements | null> => {
    await deactivateBvnkRules(rampRuntime(c), { walletId });
    await accounts.releaseFundingWallet({
      ...scope,
      id: row.id,
      transferId: lockMetadata.transferId,
    });
    return null;
  };
  const transfer = await getPaymentsRepository(c).getTransferById({
    transferId: lockMetadata.transferId,
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
  });
  if (transfer === null) {
    return releaseStaleLock();
  }
  const reservedTransfer = (holding: PaymentTransferRow): BvnkReservedTransfer => ({
    id: holding.id,
    fiatAmount: holding.fiat_amount,
    createdAt: holding.created_at,
  });
  switch (transfer.status) {
    case "pending":
    case "awaiting_payment":
      return {
        provider: "bvnk",
        direction: input.direction,
        status: "funding_wallet_reserved",
        transfer: reservedTransfer(transfer),
      };
    case "settling":
      return {
        provider: "bvnk",
        direction: input.direction,
        status: "funding_wallet_settling",
        transfer: reservedTransfer(transfer),
      };
    case "failed":
    case "canceled":
    case "completed":
    case "expired":
      return releaseStaleLock();
    case "processing":
    case "confirmed":
    case "finalized":
      throw internalError(
        `BVNK funding wallet is locked by a transfer in unresolvable status: ${transfer.status}`
      );
    default: {
      const exhaustive: never = transfer.status;
      throw internalError(
        `BVNK funding wallet is locked by a transfer in unresolvable status: ${String(exhaustive)}`
      );
    }
  }
}
