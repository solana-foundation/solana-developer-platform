import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  HERCLE_ADDRESS_CITY_FIELD_KEY,
  HERCLE_ADDRESS_LINE1_FIELD_KEY,
  HERCLE_ADDRESS_POSTAL_CODE_FIELD_KEY,
  HERCLE_PRIVACY_CONSENT_FIELD_KEY,
  HERCLE_REGISTRATION_COUNTRY_FIELD_KEY,
  HERCLE_REGISTRATION_NUMBER_FIELD_KEY,
  HERCLE_TERMS_CONSENT_FIELD_KEY,
  hercleJurisdictionForCountry,
} from "@sdp/payments/ramps/providers/hercle/counterparty";
import {
  type HercleCustomerState,
  type HercleVerificationStatus,
  hercleOnboardingRequirements,
  mapHercleVerificationStatus,
} from "@sdp/payments/ramps/providers/hercle/provider-data";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import { getDb } from "@/db";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import {
  type CounterpartyProviderAccountsRepository,
  hercleCustomerLinkMetadataSchema,
} from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { badRequest, internalError, unsupportedCounterparty } from "@/lib/errors";
import { rampRuntime } from "@/routes/payments/context";
import type { AppContext } from "@/routes/webhooks/ramps/processor";

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
 * verification lifecycle in its metadata. Hercle offers no off-ramp, so there is no payout account
 * and no bank detail anywhere on SDP's side.
 */
export interface HercleCounterpartyLink {
  accountId: string;
  linkRowId: string;
  state: HercleCustomerState;
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

  return {
    accountId: link.provider_customer_reference,
    linkRowId: link.id,
    state: { verificationStatus: metadata.verificationStatus },
  };
}

/**
 * Staged ensure-provisioning for Hercle (TS-SUBACC-03 / TS-KYC-01 lanes):
 * (1) create the Hercle business sub-account (idempotent by the counterparty-scoped Idempotency-Key,
 * replayed on retry) and link it, (2) initiate or refresh the KYB verification.
 * The completed step persists as a provider-account row, so a mid-flight failure resumes on the
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

    // Hercle opens no account for a business that has not accepted its terms and privacy policy; the collect
    // step carries both as consent fields and SDP attests them on the business's behalf (TS-KYC-01 D14).
    const termsAccepted = collectedData?.[HERCLE_TERMS_CONSENT_FIELD_KEY] === "true";
    const privacyAccepted = collectedData?.[HERCLE_PRIVACY_CONSENT_FIELD_KEY] === "true";
    if (!termsAccepted || !privacyAccepted) {
      throw badRequest(
        "The business must accept Hercle's Terms & Conditions and Privacy Policy to provision a Hercle account."
      );
    }

    // The moment SDP attests the consent, which is not the moment the business gave it: the collect step
    // carries the two flags as booleans and no timestamp, so provisioning time is the earliest instant this
    // side can evidence. Carrying the real one would mean a timestamped consent field on the collect schema.
    const attestedAt = new Date().toISOString();

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
        consents: {
          termsAndConditions: termsAccepted,
          privacyPolicy: privacyAccepted,
          acceptedAt: attestedAt,
        },
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
    };
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
 * The link a quote may act on, or null when the business cannot transact yet: no sub-account, or
 * KYB not approved. Hercle refuses orders on both counts; gating here turns a provider error into
 * the provisioning status the wizard already renders.
 */
export async function readReadyHercleCounterpartyLink(
  c: AppContext,
  counterparty: CounterpartyRow
): Promise<HercleCounterpartyLink | null> {
  const link = await readHercleCounterpartyLink(c, counterparty);
  if (link === null || link.state.verificationStatus !== "ready") {
    return null;
  }
  return link;
}
