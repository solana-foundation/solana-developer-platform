import { hashString } from "@sdp/payments/hash";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  buildBvnkThirdPartyRuleEntity,
  bvnkOfframpAccountType,
  bvnkOfframpFields,
  isBvnkOfframpCurrency,
} from "@sdp/payments/ramps/providers/bvnk/counterparty";
import {
  type BvnkOfframpBeneficiary,
  type BvnkOfframpWallet,
  type BvnkCryptoCurrency,
  type BvnkNetwork,
  buildBvnkOfframpWalletName,
  buildBvnkOnrampRuleReference,
  buildBvnkOnrampWalletName,
  buildBvnkWalletIdempotencyKey,
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
  isBvnkOfframpCurrency,
} from "@sdp/payments/ramps/providers/bvnk/counterparty";
import { isBvnkFiatCurrency } from "@sdp/payments/ramps/providers/bvnk/currencies";
import type {
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletProfileV2,
  BvnkLedgerWalletV2,
  BvnkRuleListEntry,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import {
  bvnkOnrampTransferProviderDataSchema,
  createBvnkContactV3InputSchema,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import {
  buildRequirementSchema,
  countryField,
  dateField,
  parseCollectedFields,
  textField,
} from "@sdp/payments/ramps/requirements";
import { rampId } from "@sdp/payments/ramps/shared";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type {
  BvnkBankFundingDetails,
  BvnkPaymentRampInstruction,
  CryptoRailId,
  PaymentRampQuote,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { asTransactionalClient, getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { createSystemTransactionalPaymentsRepository } from "@/db/repositories";
import type {
  PaymentsRepository,
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import {
  AppError,
  badRequest,
  conflict,
  counterpartyNotProvisioned,
  internalError,
  providerUnavailable,
} from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import { type AppContext, getPaymentsRepository, rampRuntime } from "../../context";

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
 * Maps the BVNK fiat payment instrument into the persisted bank-account shape,
 * carrying the transfer id as the remittance reference the customer writes on
 * the fiat transfer so BVNK can attribute the pay-in.
 *
 * @param wallet - BVNK v2 ledger wallet.
 * @param remittanceReference - SDP payment transfer id used as the remittance reference.
 * @returns The bank-account details, or a bare reference when the wallet has no instrument.
 */
function bvnkWalletBankAccount(
  wallet: BvnkLedgerWalletV2,
  remittanceReference: string
): BvnkBankFundingDetails {
  const instrument = wallet.paymentInstruments[0];
  if (instrument === undefined) {
    return { paymentReference: remittanceReference };
  }
  return {
    accountNumber: instrument.accountNumber,
    code: instrument.bankDetails.bic,
    paymentReference: remittanceReference,
    bankName: instrument.bankDetails.name,
  };
}

/**
 * Ensures the counterparty's virtual funding wallet row exists for one fiat
 * currency and is bound to a BVNK ledger wallet. The unbound row
 * (external_account_reference NULL) is claimed in its own committed
 * transaction BEFORE the BVNK create, so a crash between create and bind
 * never rolls the claim back; a retry then reuses the same row, whose id
 * seeds the idempotency key and makes BVNK return the same wallet instead of
 * minting an orphan. The bind is a compare-and-swap matching only while the
 * row carries no reference, so a concurrent provisioner's bind wins exactly
 * once and the loser adopts the winner's wallet (same idempotency key).
 *
 * @param c - Request context used for database access.
 * @param ctx - Ramp runtime context used for provider access.
 * @param counterparty - Counterparty owning the wallet.
 * @param projectId - Project that owns the counterparty.
 * @param fiatCurrency - Fiat currency the wallet accepts.
 * @returns The bound virtual funding wallet row.
 */
export async function ensureBvnkVirtualFundingWallet(
  c: AppContext,
  ctx: RampRuntimeContext,
  counterparty: CounterpartyRow,
  projectId: string,
  fiatCurrency: RampFiatCurrency
): Promise<CounterpartyProviderAccountRow> {
  const scope = {
    organizationId: counterparty.organization_id,
    projectId,
    counterpartyId: counterparty.id,
    provider: "bvnk" as const,
  };
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const existing = await accounts.getVirtualFundingWallet({ ...scope, fiatCurrency });
  if (existing !== null && existing.external_account_reference !== null) {
    return existing;
  }
  let claim = existing;
  if (claim === null) {
    claim = await getDb(c.env).transaction(async (transaction) => {
      const txAccounts = createPostgresCounterpartyProviderAccountsRepository(
        asTransactionalClient(transaction)
      );
      try {
        return await txAccounts.insertPendingVirtualFundingWallet({ ...scope, fiatCurrency });
      } catch (error) {
        if (!isPostgresUniqueViolation(error)) {
          throw error;
        }
        const raced = await txAccounts.getVirtualFundingWallet({ ...scope, fiatCurrency });
        if (raced !== null) {
          return raced;
        }
        throw internalError("BVNK funding-wallet claim raced into a vanished reservation.");
      }
    });
  }
  const walletProfile = selectBvnkWalletProfile(
    await client.listLedgerWalletProfilesV2(ctx, { currency: fiatCurrency }),
    fiatCurrency
  );
  const wallet = await client.createLedgerWalletV2(ctx, {
    currency: fiatCurrency,
    name: buildBvnkOnrampWalletName(counterparty.id, fiatCurrency),
    profileId: walletProfile.id,
    idempotencyKey: await buildBvnkWalletIdempotencyKey(claim.id),
  });
  const completed = await accounts.completeVirtualFundingWalletReference({
    ...scope,
    id: claim.id,
    externalAccountReference: wallet.id,
    providerStatus: wallet.status,
  });
  if (completed !== null) {
    return completed;
  }
  const bound = await accounts.getVirtualFundingWallet({ ...scope, fiatCurrency });
  if (bound !== null && bound.external_account_reference !== null) {
    return bound;
  }
  throw internalError("BVNK funding-wallet reservation was lost underneath the wallet assignment.");
}

/** Identity and delivery inputs needed to create a transfer's BVNK on-ramp rule. */
export interface BvnkOnrampRuleCreateDeps {
  counterparty: CounterpartyRow;
  contactId: string;
  currency: BvnkCryptoCurrency;
  network: BvnkNetwork;
  destinationWalletAddress: string;
}

interface BvnkOnrampRuleState {
  ruleId: string;
  ruleStatus: string;
}

/** Transfer fields rule resolution reads and binds against. */
export type BvnkOnrampRuleTransfer = Pick<
  PaymentTransferRow,
  "id" | "organization_id" | "project_id" | "provider_data"
>;

/**
 * Resolves the transfer's payment rule: a bound rule is returned as stored;
 * an unbound one is reconciled against the wallet's rules — exactly one
 * ACTIVE rule carrying this transfer's reference is adopted via a
 * compare-and-swap (a crash between create and bind), several matches abort
 * with providerUnavailable, and no match creates a fresh rule when the
 * caller supplies create inputs (the quote) or leaves the transfer unbound
 * otherwise (recovery touches that have nothing to create).
 *
 * @param payments - Payments repository used for the rule-binding CAS.
 * @param ctx - Ramp runtime context used for provider access.
 * @param transfer - The on-ramp transfer the rule belongs to.
 * @param walletId - BVNK ledger wallet id the rule is applied to.
 * @param createDeps - Rule-creation inputs, or null when creation is not possible at this call site.
 * @returns The bound rule id and status, or null when no rule exists and none can be created.
 */
export async function resolveBvnkOnrampRule(
  payments: PaymentsRepository,
  ctx: RampRuntimeContext,
  transfer: BvnkOnrampRuleTransfer,
  walletId: string,
  createDeps: BvnkOnrampRuleCreateDeps
): Promise<BvnkOnrampRuleState>;
export async function resolveBvnkOnrampRule(
  payments: PaymentsRepository,
  ctx: RampRuntimeContext,
  transfer: BvnkOnrampRuleTransfer,
  walletId: string,
  createDeps: null
): Promise<BvnkOnrampRuleState | null>;
export async function resolveBvnkOnrampRule(
  payments: PaymentsRepository,
  ctx: RampRuntimeContext,
  transfer: BvnkOnrampRuleTransfer,
  walletId: string,
  createDeps: BvnkOnrampRuleCreateDeps | null
): Promise<BvnkOnrampRuleState | null> {
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const bvnk = bvnkOnrampTransferProviderDataSchema.parse(transfer.provider_data).bvnk;
  if (bvnk.ruleId !== undefined) {
    if (bvnk.ruleStatus === undefined) {
      throw internalError("BVNK on-ramp transfer is bound to a rule without a rule status.");
    }
    return { ruleId: bvnk.ruleId, ruleStatus: bvnk.ruleStatus };
  }
  const reference = buildBvnkOnrampRuleReference(transfer.id);
  const rules = await client.listOnrampRulesByWallet(ctx, { walletId });
  const matches = rules.filter(
    (rule) => rule.status === "ACTIVE" && rule.reference === reference
  );
  if (matches.length > 1) {
    throw providerUnavailable(
      `BVNK on-ramp rules for transfer ${transfer.id} are ambiguous (${matches
        .map((match) => match.id)
        .join(", ")}); refusing to pick one.`
    );
  }
  if (matches.length === 1) {
    const bound = await payments.bindBvnkOnrampRule({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      ruleId: matches[0].id,
      ruleStatus: matches[0].status,
      updatedAt: new Date().toISOString(),
    });
    if (bound === null) {
      throw internalError("BVNK on-ramp rule reservation was lost underneath the rule assignment.");
    }
    return { ruleId: matches[0].id, ruleStatus: matches[0].status };
  }
  if (createDeps === null) {
    return null;
  }
  return createBvnkOnrampRule(payments, ctx, transfer, walletId, rules, createDeps);
}

/**
 * Creates the per-transfer BVNK payment rule. Stray ACTIVE rules that are not
 * held by an in-flight transfer (failed deactivations) are deactivated first
 * and never reused; a deactivation failure surfaces as a provider error. The
 * new rule is bound to the transfer via a compare-and-swap matching only
 * while no rule is bound yet.
 *
 * @param payments - Payments repository used for the rule-binding CAS.
 * @param ctx - Ramp runtime context used for provider access.
 * @param transfer - The in-flight on-ramp transfer the rule belongs to.
 * @param walletId - BVNK ledger wallet id the rule is applied to.
 * @param rules - The wallet's rules as last listed, swept for strays.
 * @param deps - Identity and delivery inputs for the rule's beneficiary.
 * @returns The bound rule id and status.
 */
async function createBvnkOnrampRule(
  payments: PaymentsRepository,
  ctx: RampRuntimeContext,
  transfer: BvnkOnrampRuleTransfer,
  walletId: string,
  rules: BvnkRuleListEntry[],
  deps: BvnkOnrampRuleCreateDeps
): Promise<BvnkOnrampRuleState> {
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  for (const rule of rules) {
    if (rule.status !== "ACTIVE") {
      continue;
    }
    const held = await payments.findInFlightTransferByBvnkRuleId({
      ruleId: rule.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
    });
    if (held !== null) {
      continue;
    }
    await client.deactivateOnrampRule(ctx, { ruleId: rule.id });
  }
  const contact = await client.getContactV3(ctx, { contactId: deps.contactId });
  const created = await client.createOnrampRule(ctx, {
    reference: buildBvnkOnrampRuleReference(transfer.id),
    walletId,
    currency: deps.currency,
    network: deps.network,
    beneficiaryAddress: deps.destinationWalletAddress,
    entity: buildBvnkThirdPartyRuleEntity(contact, deps.counterparty.id),
  });
  const bound = await payments.bindBvnkOnrampRule({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    ruleId: created.id,
    ruleStatus: created.status,
    updatedAt: new Date().toISOString(),
  });
  if (bound === null) {
    throw internalError("BVNK on-ramp rule reservation was lost underneath the rule assignment.");
  }
  return { ruleId: created.id, ruleStatus: created.status };
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
 * keyed per fiat currency in provider_data.bvnk.offramp.wallets. No
 * customer/KYC: the wallet is owned by the merchant. A freshly-created wallet
 * is not immediately ACTIVE; when a stored wallet is still inactive its
 * status is refreshed from BVNK so the requirements flow can keep returning
 * `provisioning` until BVNK activates it.
 *
 * @param c - Request context used for provider and repository access.
 * @param ctx - Ramp runtime context used for provider access.
 * @param counterparty - Counterparty owning the wallet.
 * @param projectId - Project that owns the counterparty.
 * @param fiatCurrency - Fiat currency the wallet accepts.
 * @returns The provisioned off-ramp wallet marker.
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
  const walletName = buildBvnkOfframpWalletName(counterparty.id, fiatCurrency);
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
 *
 * @param c - Request context used for persistence and audit.
 * @param input - Counterparty, project, fiat currency, and the collected bank details.
 * @returns The registered beneficiary marker.
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
    await audit.complete(intent);
  } catch (error) {
    await audit.fail(intent, error);
    throw error;
  }
  return beneficiary;
}

/**
 * Identity fields a BVNK third-party contact collects, keyed by the
 * counterparty entity type. The values are request-only: they are sent to BVNK
 * to create the contact and are never persisted or logged.
 *
 * @param entityType - Counterparty entity type.
 * @returns The collect fields for the entity type.
 */
export function bvnkContactFields(entityType: CounterpartyRow["entity_type"]): RequirementField[] {
  const address: RequirementField = {
    kind: "address",
    key: "address",
    label: entityType === "individual" ? "Residential address" : "Registered address",
    required: true,
    fields: [
      textField({ key: "address.addressLine1", label: "Address line 1", required: true }),
      textField({ key: "address.city", label: "City", required: true }),
      textField({ key: "address.postalCode", label: "Postal code", required: true }),
      countryField({ key: "address.country", label: "Country", required: true }),
      textField({
        key: "address.stateCode",
        label: "State",
        required: false,
        maxLength: 2,
        pattern: "^(?:[A-Z]{2})?$",
      }),
    ],
  };
  if (entityType === "individual") {
    return [
      textField({ key: "firstName", label: "First name", required: true }),
      textField({ key: "lastName", label: "Last name", required: true }),
      dateField({
        key: "dateOfBirth",
        label: "Date of birth",
        required: true,
        before: new Date().toISOString().slice(0, 10),
      }),
      address,
    ];
  }
  return [
    textField({ key: "legalName", label: "Legal name", required: true }),
    textField({ key: "registrationNumber", label: "Registration number", required: false }),
    address,
  ];
}

/**
 * Builds the collect requirement for the BVNK contact identity step, shared by
 * both ramp directions.
 *
 * @param direction - Ramp direction used in the requirement response.
 * @param entityType - Counterparty entity type selecting the collected fields.
 * @returns The collect requirement.
 */
export function bvnkCollectRequirements(
  direction: RampDirection,
  entityType: CounterpartyRow["entity_type"]
): CounterpartyRequirements {
  return { provider: "bvnk", direction, status: "collect", fields: bvnkContactFields(entityType) };
}

/**
 * Advances the BVNK contact step: claims the counterparty's customer-link
 * slot as a pending row in its own committed transaction, creates (or adopts
 * after a crash) the third-party contact at BVNK, then activates the row via
 * a standalone compare-and-swap that matches only while the row is unbound.
 * No database transaction spans a BVNK call, so a provider crash never rolls
 * the claim back behind a contact that already exists. A pending row left by
 * a crashed advance is reconciled against BVNK contacts listed by
 * description: exactly one match is adopted without a create, several
 * matches abort with providerUnavailable, and no match proceeds to create.
 * If the compare-and-swap loses to a concurrent advance, the contact this
 * request created is deleted at BVNK and the request fails with conflict.
 *
 * @param c - Request context used for provider and repository access.
 * @param input - Counterparty, project, and the collected identity fields.
 * @returns The BVNK contact id bound to the customer-link row.
 */
export async function advanceBvnkContact(
  c: AppContext,
  input: { counterparty: CounterpartyRow; projectId: string; collectedData: CollectedFieldData }
): Promise<{ contactId: string }> {
  const fields = bvnkContactFields(input.counterparty.entity_type);
  const collected = parseCollectedFields(
    fields,
    input.collectedData,
    "Missing or invalid identity fields for the BVNK contact."
  );
  const ctx = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const scope = {
    organizationId: input.counterparty.organization_id,
    projectId: input.projectId,
    counterpartyId: input.counterparty.id,
    provider: "bvnk" as const,
  };
  const isIndividual = input.counterparty.entity_type === "individual";
  if (collected["address.country"] === "US" && collected["address.stateCode"] === undefined) {
    throw badRequest("State is required for US BVNK contacts.");
  }
  const entity = createBvnkContactV3InputSchema.shape.entity.parse({
    type: isIndividual ? "INDIVIDUAL" : "COMPANY",
    relationshipType: "THIRD_PARTY",
    ...(isIndividual
      ? {
          firstName: collected["firstName"],
          lastName: collected["lastName"],
          dateOfBirth: collected["dateOfBirth"],
        }
      : {
          legalName: collected["legalName"],
          ...(collected["registrationNumber"] === undefined
            ? {}
            : { registrationNumber: collected["registrationNumber"] }),
        }),
    address: {
      addressLine1: collected["address.addressLine1"],
      city: collected["address.city"],
      postalCode: collected["address.postalCode"],
      country: collected["address.country"],
      ...(collected["address.country"] === "US"
        ? { stateCode: collected["address.stateCode"] }
        : {}),
    },
  });
  const claim = await getDb(c.env).transaction(async (transaction) => {
    const accounts = createPostgresCounterpartyProviderAccountsRepository(
      asTransactionalClient(transaction)
    );
    const pending = await accounts.getPendingCustomerLink(scope);
    if (pending !== null) {
      return { row: pending, preExisted: true };
    }
    try {
      const claimed = await accounts.claimPendingCustomerLink(scope);
      return { row: claimed, preExisted: false };
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw conflict("A BVNK contact submission for this counterparty is already in progress.");
      }
      throw error;
    }
  });
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  let contactId: string;
  let createdThisRequest = false;
  if (claim.preExisted) {
    const contacts = await client.listContactsV3(ctx, { q: input.counterparty.id, pageSize: 5 });
    const matches = contacts.filter((contact) => contact.description === input.counterparty.id);
    if (matches.length > 1) {
      throw providerUnavailable(
        `BVNK contact lookup for ${input.counterparty.id} is ambiguous (${matches
          .map((match) => match.id)
          .join(", ")}); refusing to pick one.`
      );
    }
    if (matches.length === 1) {
      contactId = matches[0].id;
    } else {
      const contact = await client.createContactV3(ctx, {
        description: input.counterparty.id,
        entity,
      });
      contactId = contact.id;
      createdThisRequest = true;
    }
  } else {
    const contact = await client.createContactV3(ctx, {
      description: input.counterparty.id,
      entity,
    });
    contactId = contact.id;
    createdThisRequest = true;
  }
  const completed = await accounts.completeCustomerLink({
    ...scope,
    id: claim.row.id,
    providerCustomerReference: contactId,
  });
  if (completed === null) {
    if (createdThisRequest) {
      await client.deleteContactV3(ctx, { contactId });
      getLogger().warn(
        {
          event: "sdp_api_bvnk_contact_orphan_deleted",
          contactId,
          rowId: claim.row.id,
          counterpartyId: input.counterparty.id,
        },
        "Deleted a BVNK contact that lost the customer-link completion race"
      );
      throw conflict("A BVNK contact for this counterparty was created concurrently.");
    }
    return { contactId };
  }
  return { contactId };
}

export interface BvnkProvisioningAudit {
  begin(event: { action: string; metadata: Record<string, unknown> }): Promise<AuditIntent>;
  complete(intent: AuditIntent, metadata?: Record<string, unknown>): Promise<void>;
  /** Resolves the intent with a failure outcome, so a routine provider error
   * does not strand an unresolved intent that pollutes ledger verification.
   * The outcome records that the ATTEMPT failed, never that the provider-side
   * object does not exist: an ambiguous error (a timeout after the provider
   * accepted the call) may have created it, so the entry carries
   * providerOutcome: "unverified" instead of asserting a definite state. */
  fail(intent: AuditIntent, error: unknown): Promise<void>;
}

/**
 * Admitted intent/outcome audit bound to a counterparty: `begin` writes a
 * durable intent BEFORE the effect, and `complete`/`fail` resolve it with the
 * provider-assigned ids or an unverified outcome after the local state is
 * persisted. Provider-side objects created here (wallets, payout
 * beneficiaries, payment rules) decide where future settlements land, so their
 * creation must be attributable; the route path binds the request actor, the
 * webhook path a system actor.
 *
 * @param c - Request context used for the audit service.
 * @param counterparty - Counterparty the provisioning step belongs to.
 * @returns The bound audit handle.
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
    async complete(intent, metadata = {}) {
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

export interface BvnkOnrampQuoteInput {
  counterparty: CounterpartyRow;
  organizationId: string;
  projectId: string;
  destinationCustodyWalletId: string;
  destinationWalletId: string;
  destinationWalletAddress: string;
  transferId: string;
  assetRail: CryptoRailId;
  currency: BvnkCryptoCurrency;
  network: BvnkNetwork;
  fiatCurrency: RampFiatCurrency;
  fiatAmount: string | null;
  rampsMemo?: Record<string, string>;
}

/**
 * Creates a BVNK on-ramp quote under the rule-as-lock model: the transfer row
 * is the lock, one payment rule per transfer, one in-flight on-ramp transfer
 * per virtual funding wallet. The fiat gate and the counterparty contact are
 * enforced before any BVNK call; the funding wallet is provisioned on demand;
 * the transfer row is claimed `awaiting_payment` (a unique-violation race
 * becomes a conflict naming the blocking transfer); the per-transfer rule is
 * recovered, swept, and created before being CAS'd onto the transfer.
 *
 * @param c - Request context used for provider and repository access.
 * @param input - Counterparty, destination wallet, and funding specification.
 * @returns The manual-instructions quote and the claimed transfer id.
 */
export async function bvnkOnrampQuote(
  c: AppContext,
  input: BvnkOnrampQuoteInput
): Promise<{ quote: BvnkOnrampQuote; transferId: string }> {
  const {
    counterparty,
    organizationId,
    projectId,
    destinationCustodyWalletId,
    destinationWalletId,
    destinationWalletAddress,
    transferId,
    assetRail,
    currency,
    network,
    fiatCurrency,
    fiatAmount,
    rampsMemo,
  } = input;
  if (!isBvnkFiatCurrency(fiatCurrency)) {
    throw badRequest(`BVNK on-ramp does not support funding in ${fiatCurrency}.`);
  }
  const scope = {
    organizationId,
    projectId,
    counterpartyId: counterparty.id,
    provider: "bvnk" as const,
  };
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const link = await accounts.getProviderAccount(scope);
  if (link === null || !link.provider_customer_reference) {
    throw counterpartyNotProvisioned("bvnk", "onramp");
  }
  const ctx = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const payments = getPaymentsRepository(c);
  const walletRow = await ensureBvnkVirtualFundingWallet(
    c,
    ctx,
    counterparty,
    projectId,
    fiatCurrency
  );
  if (walletRow.external_account_reference === null) {
    throw internalError("BVNK funding wallet has no wallet id bound to its provider-account row.");
  }
  const inFlight = await payments.getInFlightBvnkOnrampTransferByFundingWallet({
    fundingWalletAccountId: walletRow.id,
  });
  if (inFlight !== null) {
    await resolveBvnkOnrampRule(
      payments,
      ctx,
      inFlight,
      walletRow.external_account_reference,
      null
    );
    throw conflict(`BVNK on-ramp ${inFlight.id} is still in flight for this funding account`);
  }
  const wallet = await client.getLedgerWalletV2(ctx, {
    walletId: walletRow.external_account_reference,
  });
  if (!isBvnkWalletActive(wallet.status)) {
    throw counterpartyNotProvisioned("bvnk", "onramp");
  }
  let transfer: PaymentTransferRow;
  const apiKey = c.get("apiKey");
  try {
    transfer = await getDb(c.env).transaction(async (transaction) => {
      const db = asTransactionalClient(transaction);
      const txPayments = createSystemTransactionalPaymentsRepository(db);
      const created = await txPayments.createTransfer({
        id: transferId,
        organizationId,
        projectId,
        custodyWalletId: destinationCustodyWalletId,
        walletId: destinationWalletId,
        counterpartyId: counterparty.id,
        sourceAddress: null,
        destinationAddress: destinationWalletAddress,
        token: rampTransferTokenMint(assetRail, c.env),
        amount: null,
        memo: null,
        type: "onramp",
        direction: "inbound",
        status: "awaiting_payment",
        provider: "bvnk",
        providerReference: null,
        deliveryMode: "manual_instructions",
        fiatCurrency,
        fiatAmount,
        rampsMemo,
        providerData: { bvnk: { fundingWalletAccountId: walletRow.id } },
        serializedTx: null,
        signature: null,
        slot: null,
        initiatedByKeyId: apiKey ? apiKey.id : null,
      });
      if (created === null) {
        throw internalError("Failed to create BVNK on-ramp transfer record");
      }
      return created;
    });
  } catch (error) {
    if (!isPostgresUniqueViolation(error)) {
      throw error;
    }
    const active = await payments.getInFlightBvnkOnrampTransferByFundingWallet({
      fundingWalletAccountId: walletRow.id,
    });
    if (active !== null) {
      await resolveBvnkOnrampRule(
        payments,
        ctx,
        active,
        walletRow.external_account_reference,
        null
      );
      throw conflict(`BVNK on-ramp ${active.id} is still in flight for this funding account`);
    }
    throw conflict("Another BVNK on-ramp quote raced into this funding account; retry.");
  }
  const rule = await resolveBvnkOnrampRule(
    payments,
    ctx,
    transfer,
    walletRow.external_account_reference,
    {
      counterparty,
      contactId: link.provider_customer_reference,
      currency,
      network,
      destinationWalletAddress,
    }
  );
  const bankAccount = bvnkWalletBankAccount(wallet, transfer.id);
  if (bankAccount.accountNumber === undefined) {
    throw providerUnavailable("BVNK funding wallet has no fiat payment instrument to fund.");
  }
  const instruction: BvnkPaymentRampInstruction = {
    provider: "bvnk",
    kind: "fiat_funding",
    ruleId: rule.ruleId,
    ruleStatus: rule.ruleStatus,
    fundingWalletId: wallet.id,
    fiatCurrency,
    beneficiaryAddress: destinationWalletAddress,
    network,
    bankAccount,
    instructionsNotes: `Fund your ${fiatCurrency} BVNK virtual account to receive crypto on ${network}.`,
  };
  return {
    quote: {
      provider: "bvnk",
      id: rampId("bvnk_onramp"),
      status: "pending",
      deliveryMode: "manual_instructions",
      paymentInstructions: [instruction],
    },
    transferId: transfer.id,
  };
}
