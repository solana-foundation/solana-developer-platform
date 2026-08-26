import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  HERCLE_ADDRESS_CITY_FIELD_KEY,
  HERCLE_ADDRESS_LINE1_FIELD_KEY,
  HERCLE_ADDRESS_POSTAL_CODE_FIELD_KEY,
  HERCLE_REGISTRATION_COUNTRY_FIELD_KEY,
  HERCLE_REGISTRATION_NUMBER_FIELD_KEY,
  hercleJurisdictionForCountry,
} from "@sdp/payments/ramps/providers/hercle/counterparty";
import {
  type HercleCounterpartyData,
  hercleOnboardingRequirements,
  mapHercleVerificationStatus,
  readHercleData,
} from "@sdp/payments/ramps/providers/hercle/provider-data";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import { badRequest, internalError, unsupportedCounterparty } from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { rampRuntime } from "@/routes/payments/context";
import type { AppContext } from "@/routes/webhooks/ramps/processor";

interface AdvanceHercleCounterpartyInput {
  counterparty: CounterpartyRow;
  projectId: string;
  direction: RampDirection;
  collectedData?: CollectedFieldData;
}

async function persistHercleData(
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  projectId: string,
  patch: Partial<HercleCounterpartyData>
): Promise<void> {
  await repo.mutateProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId,
    mutate: (current) => {
      const existing =
        current.hercle && typeof current.hercle === "object" && !Array.isArray(current.hercle)
          ? (current.hercle as Record<string, unknown>)
          : {};
      return { ...current, hercle: { ...existing, ...patch } };
    },
  });
}

/**
 * Staged ensure-provisioning for Hercle (TS-SUBACC-03 / TS-KYC-01 lanes):
 * (1) create the Hercle business sub-account (idempotent by the counterparty-scoped
 * Idempotency-Key, replayed on retry), (2) initiate or refresh the KYB verification.
 * Each completed step persists into provider_data.hercle, so a mid-flight failure
 * resumes on the next requirements POST — SDP re-invokes this stage until `ready`.
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

  const repo = getCounterpartiesRepository(c);
  const runtime: RampRuntimeContext = rampRuntime(c);
  const client = RAMP_PROVIDER_CLIENTS.hercle;
  let data = readHercleData(counterparty.provider_data);

  if (!data.accountId) {
    // KYB input is collected per provisioning attempt and passed straight to Hercle; SDP
    // stores none of it (only the returned account id lands in provider data).
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
    data = { accountId: account.accountId, externalReference: counterparty.id };
    await persistHercleData(repo, counterparty, projectId, data);
  }

  if (!data.accountId) {
    throw internalError("Hercle account provisioning did not yield an account id.");
  }

  if (data.verificationStatus !== "ready") {
    const verification =
      data.verificationStatus === undefined
        ? await client.createVerification(runtime, data.accountId, `sdp-kyb-${counterparty.id}`)
        : await client.getVerification(runtime, data.accountId);
    const verificationStatus = mapHercleVerificationStatus(verification.status);
    data = {
      ...data,
      verificationStatus,
      verificationUrl: verification.verificationUrl ?? data.verificationUrl,
    };
    await persistHercleData(repo, counterparty, projectId, {
      verificationStatus,
      verificationUrl: data.verificationUrl,
    });
  }

  return hercleOnboardingRequirements(data, direction);
}

/** The `on-behalf-of` account id for scoped Hercle calls; undefined until provisioned. */
export function hercleAccountId(counterparty: CounterpartyRow): string | undefined {
  return readHercleData(counterparty.provider_data).accountId;
}

/** True once the Hercle KYB verdict landed and the sub-account can transact. */
export function isHercleCounterpartyReady(counterparty: CounterpartyRow): boolean {
  return readHercleData(counterparty.provider_data).verificationStatus === "ready";
}
