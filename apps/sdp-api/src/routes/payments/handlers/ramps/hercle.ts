import { SdpPaymentsError } from "@sdp/payments/errors";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  HERCLE_ADDRESS_CITY_FIELD_KEY,
  HERCLE_ADDRESS_LINE1_FIELD_KEY,
  HERCLE_ADDRESS_POSTAL_CODE_FIELD_KEY,
  HERCLE_PAYOUT_ACCOUNT_HOLDER_FIELD_KEY,
  HERCLE_PAYOUT_BIC_FIELD_KEY,
  HERCLE_PAYOUT_IBAN_FIELD_KEY,
  HERCLE_REGISTRATION_COUNTRY_FIELD_KEY,
  HERCLE_REGISTRATION_NUMBER_FIELD_KEY,
  hercleJurisdictionForCountry,
  herclePayoutAccountFields,
} from "@sdp/payments/ramps/providers/hercle/counterparty";
import {
  type HercleCustomerState,
  type HerclePayoutAccountStatus,
  type HercleVerificationStatus,
  hercleOnboardingRequirements,
  isHerclePayoutAccountStatus,
  mapHercleVerificationStatus,
} from "@sdp/payments/ramps/providers/hercle/provider-data";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { COUNTRY_CODES, type CountryCode } from "@sdp/types";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import { getDb } from "@/db";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import {
  type CounterpartyProviderAccountRow,
  type CounterpartyProviderAccountsRepository,
  hercleCustomerLinkMetadataSchema,
} from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { badRequest, internalError, unsupportedCounterparty } from "@/lib/errors";
import { rampRuntime } from "@/routes/payments/context";
import type { AppContext } from "@/routes/webhooks/ramps/processor";

/** EUR is the only currency Hercle settles at launch, and the rails snapshot declares nothing else. */
const HERCLE_PAYOUT_CURRENCY = "EUR";

/** The rail Hercle's EUR payout account is registered on. */
const HERCLE_PAYOUT_RAIL = "sepa";

interface AdvanceHercleCounterpartyInput {
  counterparty: CounterpartyRow;
  projectId: string;
  direction: RampDirection;
  collectedData?: CollectedFieldData;
}

interface HercleScope {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider: "hercle";
}

function scopeOf(counterparty: CounterpartyRow, projectId: string): HercleScope {
  return {
    organizationId: counterparty.organization_id,
    projectId,
    counterpartyId: counterparty.id,
    provider: "hercle",
  };
}

function accountsRepository(c: AppContext): CounterpartyProviderAccountsRepository {
  return createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
}

/**
 * The counterparty's Hercle state as rows: the `customer_link` carries the sub-account id and the
 * verification lifecycle in its metadata; the `payout_account` carries the bank rail's status for
 * the business's own payout account. Bank details live in neither.
 */
export interface HercleCounterpartyLink {
  accountId: string;
  linkRowId: string;
  state: HercleCustomerState;
  payoutAccount: CounterpartyProviderAccountRow | null;
}

export async function readHercleCounterpartyLink(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string = counterparty.project_id
): Promise<HercleCounterpartyLink | null> {
  const accounts = accountsRepository(c);
  const scope = scopeOf(counterparty, projectId);
  const link = await accounts.getProviderAccount(scope);
  if (!link) {
    return null;
  }

  const metadata = hercleCustomerLinkMetadataSchema.parse(link.metadata);
  const payoutAccount = await accounts.getAccountByKindAndCurrency({
    ...scope,
    kind: "payout_account",
    fiatCurrency: HERCLE_PAYOUT_CURRENCY,
  });

  return {
    accountId: link.provider_customer_reference,
    linkRowId: link.id,
    state: {
      verificationStatus: metadata.verificationStatus,
      payoutAccountStatus: readPayoutAccountStatus(payoutAccount),
    },
    payoutAccount,
  };
}

/** Anything the rail reports that is not in the vocabulary reads as not ready, never as active. */
function readPayoutAccountStatus(
  row: CounterpartyProviderAccountRow | null
): HerclePayoutAccountStatus | undefined {
  if (row === null) {
    return undefined;
  }
  return row.provider_status !== null && isHerclePayoutAccountStatus(row.provider_status)
    ? row.provider_status
    : "pending";
}

/**
 * Staged ensure-provisioning for Hercle (TS-SUBACC-03 / TS-KYC-01 / TS-BANK-10.5 lanes):
 * (1) create the Hercle business sub-account (idempotent by the counterparty-scoped Idempotency-Key,
 * replayed on retry) and link it, (2) register the business's own payout account, (3) initiate or
 * refresh the KYB verification.
 * Each completed step persists as a provider-account row, so a mid-flight failure resumes on the
 * next requirements POST — SDP re-invokes this stage until `ready`.
 */
export async function advanceHercleCounterparty(
  c: AppContext,
  input: AdvanceHercleCounterpartyInput
): Promise<CounterpartyRequirements> {
  const { counterparty, projectId, direction, collectedData } = input;
  if (counterparty.entity_type !== "business") {
    return unsupportedCounterparty(
      "hercle",
      direction,
      "Hercle supports business counterparties only."
    );
  }

  const accounts = accountsRepository(c);
  const scope = scopeOf(counterparty, projectId);
  const runtime: RampRuntimeContext = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.hercle;

  let link = await readHercleCounterpartyLink(c, counterparty, projectId);
  if (!link) {
    // KYB input is collected per provisioning attempt and passed straight to Hercle; SDP
    // stores none of it (only the returned account id lands in the customer link).
    const registrationNumber = collectedData?.[HERCLE_REGISTRATION_NUMBER_FIELD_KEY]?.trim();
    const countryCode = collectedData?.[HERCLE_REGISTRATION_COUNTRY_FIELD_KEY]?.trim();
    const line1 = collectedData?.[HERCLE_ADDRESS_LINE1_FIELD_KEY]?.trim();
    const city = collectedData?.[HERCLE_ADDRESS_CITY_FIELD_KEY]?.trim();
    const postalCode = collectedData?.[HERCLE_ADDRESS_POSTAL_CODE_FIELD_KEY]?.trim();

    if (!registrationNumber || !countryCode || !line1 || !city || !postalCode) {
      throw badRequest(
        "registrationNumber, registrationCountry and the registered address are required to provision a Hercle account."
      );
    }

    const jurisdiction = hercleJurisdictionForCountry(countryCode);
    if (jurisdiction === undefined) {
      return unsupportedCounterparty(
        "hercle",
        direction,
        "Hercle supports businesses registered in Switzerland or the EEA only."
      );
    }

    const account = await client.createAccount(
      runtime,
      {
        companyName: counterparty.display_name,
        registrationNumber,
        registeredAddress: { line1, city, postalCode, country: countryCode },
        jurisdiction,
        fundingMode: "Funded",
        accountLabel: counterparty.display_name,
        externalReference: counterparty.id,
      },
      // Content-addressed: a retried POST replays the same Hercle account instead of duplicating it.
      `sdp-account-${counterparty.id}`
    );
    const row = await accounts.upsertProviderAccount({
      ...scope,
      providerCustomerReference: account.accountId,
      metadata: { externalReference: counterparty.id },
    });
    link = {
      accountId: account.accountId,
      linkRowId: row.id,
      state: {},
      payoutAccount: null,
    };
  }

  if (link.payoutAccount === null) {
    const iban = collectedData?.[HERCLE_PAYOUT_IBAN_FIELD_KEY]?.replace(/\s+/g, "");
    const bic = collectedData?.[HERCLE_PAYOUT_BIC_FIELD_KEY]?.trim();
    const accountHolder = collectedData?.[HERCLE_PAYOUT_ACCOUNT_HOLDER_FIELD_KEY]?.trim();

    // An account provisioned before the payout account existed re-collects only the bank details.
    if (!iban || !bic || !accountHolder) {
      return {
        provider: "hercle",
        direction,
        status: "collect",
        fields: herclePayoutAccountFields(),
      };
    }

    const destinationCountry = ibanCountry(iban);
    const registered = await registerHerclePayoutAccount(client, runtime, link.accountId, {
      currency: HERCLE_PAYOUT_CURRENCY,
      iban,
      bic,
      accountHolder,
    });
    const payoutAccount = await accounts.insertProviderResourceAccount({
      ...scope,
      kind: "payout_account",
      providerCustomerReference: link.accountId,
      fiatCurrency: HERCLE_PAYOUT_CURRENCY,
      destinationCountry,
      paymentRail: HERCLE_PAYOUT_RAIL,
      externalAccountReference: registered.payoutAccountId,
      providerStatus: registered.status,
      // The IBAN went to Hercle and nowhere else; the row is a pointer, not a copy.
      metadata: {},
    });
    link = {
      ...link,
      state: { ...link.state, payoutAccountStatus: registered.status },
      payoutAccount,
    };
  } else if (link.state.payoutAccountStatus === "pending") {
    // The rail registers the account after KYB approval; poll until it flips.
    const latest = await client.getPayoutAccount(runtime, link.accountId, HERCLE_PAYOUT_CURRENCY);
    if (latest.status !== link.state.payoutAccountStatus) {
      await accounts.updateExternalAccountStatus({
        ...scope,
        id: link.payoutAccount.id,
        providerStatus: latest.status,
      });
      link = { ...link, state: { ...link.state, payoutAccountStatus: latest.status } };
    }
  }

  let verificationUrl: string | undefined;
  if (link.state.verificationStatus !== "ready") {
    const verification =
      link.state.verificationStatus === undefined
        ? await client.createVerification(runtime, link.accountId, `sdp-kyb-${counterparty.id}`)
        : await client.getVerification(runtime, link.accountId);
    const verificationStatus = mapHercleVerificationStatus(verification.status);
    verificationUrl = verification.verificationUrl;
    if (verificationStatus !== link.state.verificationStatus) {
      await patchVerificationStatus(accounts, scope, link.linkRowId, verificationStatus);
      link = { ...link, state: { ...link.state, verificationStatus } };
    }
  }

  return hercleOnboardingRequirements(link.state, direction, verificationUrl);
}

/**
 * Requirements GET once the customer link exists. The hosted verification link is minted per read
 * (never stored), and the verification status is refreshed from Hercle so a verdict delivered while
 * the webhook was unreachable still lands.
 */
export async function resolveHercleRequirements(
  c: AppContext,
  counterparty: CounterpartyRow,
  projectId: string,
  direction: RampDirection,
  link: HercleCounterpartyLink
): Promise<CounterpartyRequirements> {
  if (link.payoutAccount === null) {
    return {
      provider: "hercle",
      direction,
      status: "collect",
      fields: herclePayoutAccountFields(),
    };
  }

  let state = link.state;
  let verificationUrl: string | undefined;
  if (state.verificationStatus !== "ready") {
    const verification = await RAMP_PROVIDER_CLIENTS.hercle.getVerification(
      rampRuntime(c),
      link.accountId
    );
    const verificationStatus = mapHercleVerificationStatus(verification.status);
    verificationUrl = verification.verificationUrl;
    if (verificationStatus !== state.verificationStatus) {
      await patchVerificationStatus(
        accountsRepository(c),
        scopeOf(counterparty, projectId),
        link.linkRowId,
        verificationStatus
      );
      state = { ...state, verificationStatus };
    }
  }

  return hercleOnboardingRequirements(state, direction, verificationUrl);
}

export async function patchVerificationStatus(
  accounts: CounterpartyProviderAccountsRepository,
  scope: HercleScope,
  linkRowId: string,
  verificationStatus: HercleVerificationStatus
): Promise<void> {
  const updated = await accounts.patchAccountMetadata({
    ...scope,
    id: linkRowId,
    set: { verificationStatus },
    unset: [],
  });
  if (!updated) {
    throw internalError("Hercle verification status update escaped its tenant scope.");
  }
}

/**
 * A repeated provisioning attempt after the first registration succeeded answers 409 from Hercle;
 * the registered account is then read back instead, so a retry converges rather than fails.
 * Any other refusal — a holder that is not the business itself — is the user's to fix, with
 * Hercle's own message.
 */
async function registerHerclePayoutAccount(
  client: typeof RAMP_PROVIDER_CLIENTS.hercle,
  runtime: RampRuntimeContext,
  accountId: string,
  request: { currency: string; iban: string; bic: string; accountHolder: string }
) {
  try {
    return await client.registerPayoutAccount(runtime, accountId, request);
  } catch (error) {
    if (error instanceof SdpPaymentsError && error.code === "CONFLICT") {
      return await client.getPayoutAccount(runtime, accountId, request.currency);
    }
    if (error instanceof SdpPaymentsError && error.code === "BAD_REQUEST") {
      throw badRequest(error.message);
    }
    throw error;
  }
}

/** The IBAN's country prefix is the payout destination; it is derived, never stored with the IBAN. */
function ibanCountry(iban: string): CountryCode {
  const prefix = iban.slice(0, 2).toUpperCase();
  if (!(COUNTRY_CODES as readonly string[]).includes(prefix)) {
    throw badRequest(`IBAN country "${prefix}" is not recognised.`);
  }
  return prefix as CountryCode;
}

/**
 * The link a quote may act on, or null when the business cannot transact yet: no sub-account, KYB
 * not approved, or the payout account not yet active on the bank rail. Hercle refuses orders on
 * each of those counts; gating here turns a provider error into the provisioning status the wizard
 * already renders.
 */
export async function readReadyHercleCounterpartyLink(
  c: AppContext,
  counterparty: CounterpartyRow
): Promise<HercleCounterpartyLink | null> {
  const link = await readHercleCounterpartyLink(c, counterparty);
  if (
    link === null ||
    link.state.verificationStatus !== "ready" ||
    link.state.payoutAccountStatus !== "active"
  ) {
    return null;
  }
  return link;
}
