import { hashString } from "@sdp/payments/hash";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type {
  BvnkAgreementsV2,
  BvnkCustomerV2Individual,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletProfileV2,
  BvnkLedgerWalletV2,
} from "@sdp/payments/ramps/providers/bvnk/client";
import {
  buildBvnkContactRequest,
  buildBvnkCustomerRequest,
  bvnkOfframpAccountType,
  bvnkOfframpFields,
  bvnkOnrampFields,
  isBvnkOfframpCurrency,
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
import { buildRequirementSchema } from "@sdp/payments/ramps/requirements";
import { rampId } from "@sdp/payments/ramps/shared";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type {
  BvnkBankFundingDetails,
  BvnkPaymentRampInstruction,
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
import { AppError, badRequest, counterpartyNotProvisioned, internalError } from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { getLogger } from "@/runtime/logger";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
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
    cryptoToken: string;
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
    token: rampTransferTokenMint(input.cryptoToken, c.env),
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
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  key: string,
  entry: BvnkOnrampPaymentRuleState,
  repository?: CounterpartiesRepository
): Promise<void> {
  const repo = repository ?? getCounterpartiesRepository(c);
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
  const agreementDetails = await Promise.all(
    pending.map(async (agreement) => {
      const content = await RAMP_PROVIDER_CLIENTS.bvnk.getAgreementContentV2(rampRuntime(c), {
        id: agreement.id,
      });
      return {
        id: agreement.id,
        filename: content.filename,
        downloadUrl: content.downloadUrl,
      };
    })
  );
  return {
    provider: "bvnk",
    direction,
    status: "customer_agreement_required",
    agreements: agreementDetails,
  };
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
export async function bvnkCustomerRequirementsFromMetadata(
  c: AppContext,
  direction: RampDirection,
  metadata: BvnkCustomerProviderAccountMetadata
): Promise<CounterpartyRequirements | null> {
  const agreements = metadata.agreements;
  if (!agreements) {
    return null;
  }
  const entries = Object.entries(agreements.entries);
  const pending = entries.filter(([, entry]) => entry.status.toUpperCase() !== "ACCEPTED");
  if (pending.length > 0) {
    if (metadata.status === undefined) {
      return {
        provider: "bvnk",
        direction,
        status: "customer_pending_agreement_acceptance",
      };
    }
    const details = await Promise.all(
      pending.map(async ([id]) => {
        const content = await RAMP_PROVIDER_CLIENTS.bvnk.getAgreementContentV2(rampRuntime(c), {
          id,
        });
        return {
          id,
          filename: content.filename,
          downloadUrl: content.downloadUrl,
        };
      })
    );
    return {
      provider: "bvnk",
      direction,
      status: "customer_agreement_required",
      agreements: details,
    };
  }
  if (metadata.status === undefined) {
    return {
      provider: "bvnk",
      direction,
      status: "collect_counterparty",
      fields: bvnkOnrampFields(),
    };
  }
  return null;
}

/**
 * Persists a BVNK agreement relay before customer creation.
 *
 * @param c - Request context used for repository access.
 * @param counterparty - Counterparty receiving the BVNK customer link.
 * @param projectId - Project that owns the counterparty.
 * @param workingSetId - BVNK agreements working-set id (the v2 customer UUID space).
 * @param entries - Required agreement state to persist.
 * @returns Nothing.
 */
async function persistBvnkAgreementState(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  workingSetId: string,
  entries: BvnkAgreementEntries
): Promise<void> {
  await getCounterpartiesRepository(c).upsertBvnkCustomerProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    customer: {
      customerReference: workingSetId,
      agreements: { relayedAt: new Date().toISOString(), entries },
    },
  });
}

/**
 * Creates the BVNK contact and customer after agreement confirmation.
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
    collectedData: CollectedFieldData;
  }
): Promise<{ customer: BvnkCustomerResolution }> {
  const contact = await input.client.createContactV3(input.ctx, {
    idempotencyKey: (await hashString(`bvnk-contact:${input.counterparty.id}`)).slice(0, 36),
    entity: buildBvnkContactRequest(input.collectedData),
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
    set: { status: created.status, contactId: contact.contactId },
    unset: [],
  });
  if (!updated) {
    throw internalError("BVNK customer status update escaped its tenant scope.");
  }
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
  c: AppContext,
  counterparty: CounterpartyRow
): Promise<BvnkCustomerResolution | null> {
  const link = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(c.env)
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
 * Creates or refreshes the BVNK v2 customer using transient collected PII.
 *
 * @param c - Request context used for provider and repository access.
 * @param counterparty - Counterparty whose provider state is resolved.
 * @param projectId - Project that owns the counterparty.
 * @param direction - Ramp direction used when returning an intermediate requirement.
 * @param collectedData - Flattened PII fields, never persisted.
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
    const storedRequirements = await bvnkCustomerRequirementsFromMetadata(c, direction, metadata);
    if (storedRequirements) {
      if (storedRequirements.status === "collect_counterparty" && collectedData !== undefined) {
        return createBvnkCustomer(c, {
          client,
          ctx,
          counterparty,
          projectId,
          reference: existing.provider_customer_reference,
          individual: buildBvnkCustomerRequest(collectedData),
          collectedData,
        });
      }
      return { requirements: storedRequirements };
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
    throw badRequest("collectedData with BVNK individual details is required.");
  }
  const individual = buildBvnkCustomerRequest(collectedData);
  const reference = buildBvnkCustomerExternalReference(counterparty.id);
  const taxResidenceCountryCode = individual.taxIdentification?.taxResidenceCountryCode;
  if (taxResidenceCountryCode === undefined) {
    throw internalError("BVNK customer request is missing tax residence country.");
  }
  const agreements = await client.createAgreementsV2(ctx, {
    idempotencyKey: (await hashString(`bvnk-agreements:${counterparty.id}`)).slice(0, 36),
    reference,
    useCase: "FIAT",
    customerType: "INDIVIDUAL",
    countryCode: taxResidenceCountryCode,
  });
  const pending = agreements.agreements.filter((agreement) => agreement.status !== "ACCEPTED");
  if (pending.length > 0 && agreementConsent === undefined) {
    return { requirements: await bvnkAgreementDetails(c, direction, agreements) };
  }
  if (pending.length > 0) {
    await client.respondAgreementsV2(ctx, {
      idempotencyKey: (await hashString(`bvnk-agreement-response:${counterparty.id}`)).slice(0, 36),
      reference,
      actions: pending.map((agreement) => ({ agreementId: agreement.id, type: "ACCEPT" })),
    });
    // Relay responses never confirm acceptance: relayed agreements seed as
    // PENDING and only the agreements status-change webhook (or the PRO-1837
    // reconciler) flips them to ACCEPTED. Working-set statuses read from
    // BVNK before the relay keep their value — that read is reconcile
    // authority, the action response is not.
    const entries: BvnkAgreementEntries = Object.fromEntries(
      agreements.agreements
        .filter((agreement) => !agreement.declinable)
        .map((agreement) => [
          agreement.id,
          { status: agreement.status === "ACCEPTED" ? "ACCEPTED" : "PENDING" },
        ])
    );
    await persistBvnkAgreementState(c, counterparty, projectId, agreements.id, entries);
    return {
      requirements: {
        provider: "bvnk",
        direction,
        status: "customer_pending_agreement_acceptance",
      },
    };
  }
  const entries: BvnkAgreementEntries = Object.fromEntries(
    agreements.agreements
      .filter((agreement) => !agreement.declinable)
      .map((agreement) => [agreement.id, { status: agreement.status }])
  );
  await persistBvnkAgreementState(c, counterparty, projectId, agreements.id, entries);
  return {
    requirements: {
      provider: "bvnk",
      direction,
      status: "collect_counterparty",
      fields: bvnkOnrampFields(),
    },
  };
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
  params: BvnkOnrampRequestSpec,
  repository?: CounterpartiesRepository
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
    await persistBvnkOnrampState(c, counterparty, projectId, paymentRuleKey, entry, repository);
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
    await persistBvnkOnrampState(c, counterparty, projectId, paymentRuleKey, entry, repository);
  }

  if (entry.walletId && !isBvnkWalletActive(entry.walletStatus)) {
    try {
      const wallet = await client.getLedgerWalletV2(ctx, { walletId: entry.walletId });
      entry = {
        ...entry,
        walletStatus: wallet.status,
        bankAccount: bvnkWalletBankAccount(wallet) ?? entry.bankAccount,
      };
      await persistBvnkOnrampState(c, counterparty, projectId, paymentRuleKey, entry, repository);
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
    entry = { ...entry, ruleId: rule.id ?? entry.ruleId, ruleStatus: rule.status };
    await persistBvnkOnrampState(c, counterparty, projectId, paymentRuleKey, entry, repository);
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
