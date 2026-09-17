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
  type BvnkOnrampPaymentRuleState,
  type BvnkOnrampRequestSpec,
  buildBvnkOfframpWalletName,
  buildBvnkOnrampInstruction,
  buildBvnkOnrampPaymentRuleKey,
  buildBvnkOnrampWalletName,
  buildBvnkWalletIdempotencyKey,
  bvnkRuleReference,
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
import type {
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletProfileV2,
  BvnkLedgerWalletV2,
  BvnkOnrampTransferProviderData,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import { createBvnkContactV3InputSchema } from "@sdp/payments/ramps/providers/bvnk/schemas";
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
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type {
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

/**
 * Advances on-ramp provisioning (wallet profile → create/get wallet → create
 * rule) for a contact-backed counterparty + funding spec, on merchant-owned
 * wallets. Persists entry state to counterparty.provider_data.bvnk.wallets[key]
 * after each completed step; the rule entity is built JIT from the BVNK
 * contact at rule-creation time only. Rule creation still waits for the wallet
 * to be ACTIVE.
 *
 * @param ctx - Ramp runtime context used for provider access.
 * @param repository - Counterparty repository used for provider-data persistence.
 * @param counterparty - Counterparty being provisioned.
 * @param projectId - Project that owns the counterparty.
 * @param contactId - BVNK contact id bound to the counterparty.
 * @param params - Funding specification for the on-ramp.
 * @param audit - Provisioning audit bound to the counterparty.
 * @returns The persisted rule state and the resulting onboarding status.
 */
export async function ensureBvnkPaymentRule(
  ctx: RampRuntimeContext,
  repository: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  projectId: string,
  contactId: string,
  params: BvnkOnrampRequestSpec,
  audit: BvnkProvisioningAudit
): Promise<{ entry: BvnkOnrampPaymentRuleState; onboardingStatus: "ready" | "provisioning" }> {
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
    return { entry, onboardingStatus: "ready" };
  }

  if (!entry.request) {
    entry = { ...entry, request: params };
    await persistBvnkOnrampState(repository, counterparty, projectId, paymentRuleKey, entry);
  }

  if (entry.provisioningError) {
    entry = { ...entry, provisioningError: undefined };
  }

  if (!entry.walletId) {
    const walletName = buildBvnkOnrampWalletName(counterparty.id, paymentRuleKey);
    const walletProfile = selectBvnkWalletProfile(
      await client.listLedgerWalletProfilesV2(ctx, { currency: params.fiatCurrency }),
      params.fiatCurrency
    );
    const walletIntent = await audit.begin({
      action: "bvnk_onramp_wallet_created",
      metadata: { walletName, fiatCurrency: params.fiatCurrency },
    });
    try {
      const wallet = await client.createLedgerWalletV2(ctx, {
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
    } catch (error) {
      await audit.fail(walletIntent, error);
      throw error;
    }
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
    try {
      const contact = await client.getContactV3(ctx, { contactId });
      const rule = await client.createOnrampRule(ctx, {
        reference: await bvnkRuleReference(counterparty.id, paymentRuleKey),
        walletId: entry.walletId,
        currency: params.currency,
        network: params.network,
        beneficiaryAddress: params.destinationWalletAddress,
        entity: buildBvnkThirdPartyRuleEntity(contact, counterparty.id),
      });
      entry = { ...entry, ruleId: rule.id, ruleStatus: rule.status };
      await persistBvnkOnrampState(repository, counterparty, projectId, paymentRuleKey, entry);
      await audit.complete(ruleIntent, { ruleId: rule.id });
    } catch (error) {
      await audit.fail(ruleIntent, error);
      throw error;
    }
  }

  return {
    entry,
    onboardingStatus: entry.ruleId && entry.bankAccount?.accountNumber ? "ready" : "provisioning",
  };
}

/**
 * Builds the on-ramp quote instructions from the persisted rule state.
 *
 * @param c - Request context used for the environment mode.
 * @param input - Counterparty and the funding specification.
 * @returns The manual-instructions quote and its transfer provider data.
 */
export async function bvnkOnrampQuote(
  c: AppContext,
  input: { counterparty: CounterpartyRow; paymentRule: BvnkOnrampRequestSpec }
): Promise<{ quote: BvnkOnrampQuote; transferProviderData: BvnkOnrampTransferProviderData }> {
  const { currency, network, destinationWalletAddress, fiatCurrency } = input.paymentRule;
  const key = buildBvnkOnrampPaymentRuleKey(
    fiatCurrency,
    currency,
    network,
    destinationWalletAddress
  );
  const entry = readBvnkOnrampPaymentRuleState(input.counterparty.provider_data, key);

  if (!entry.ruleId || !entry.walletId || !entry.bankAccount?.accountNumber) {
    throw counterpartyNotProvisioned("bvnk", "onramp");
  }
  const instruction = buildBvnkOnrampInstruction(
    { entry },
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
