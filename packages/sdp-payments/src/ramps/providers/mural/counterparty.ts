import type { Counterparty, CountryCode } from "@sdp/types";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import { badRequest, unsupportedCounterparty } from "../../../errors";
import {
  addressFields,
  buildRequirementSchema,
  parseCollectedAddress,
  readyCounterparty,
} from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  isMuralTosAccepted,
  type MuralOrganizationResolution,
  readMuralOrganization,
} from "./provider-data";

export interface MuralPhysicalAddress {
  address1: string;
  country: CountryCode;
  state?: string;
  city: string;
  zip: string;
}

/**
 * Builds Mural's physical address from transient ramp fields.
 *
 * @param country Counterparty country supplied for the ramp.
 * @param collectedData Transient address values supplied for the ramp.
 * @returns Mural's physical-address payload without persisting collected values.
 */
export function buildMuralPhysicalAddress(
  country: CountryCode,
  collectedData: CollectedFieldData | undefined
): MuralPhysicalAddress {
  const collected = parseCollectedAddress(
    country,
    collectedData,
    "Missing or invalid physical address required for Mural."
  );
  const address: MuralPhysicalAddress = {
    address1: collected.line1,
    country,
    city: collected.city,
    zip: collected.postalCode,
  };
  if (collected.subdivisionCode !== undefined) {
    address.state = collected.subdivisionCode;
  }
  return address;
}

export function muralOnboardingRequirements(
  org: MuralOrganizationResolution,
  direction: RampDirection
): CounterpartyRequirements {
  if (!org.id) {
    return { provider: "mural", direction, status: "onboarding_not_started" };
  }
  if (org.kycStatus === "approved") {
    return readyCounterparty("mural", direction);
  }
  if (org.kycStatus === "pending") {
    return { provider: "mural", direction, status: "customer_verifying" };
  }
  if (org.kycStatus === "errored" || org.kycStatus === "rejected") {
    return { provider: "mural", direction, status: "customer_verification_failed" };
  }
  if (!isMuralTosAccepted(org.tosStatus)) {
    if (org.tosLink) {
      return {
        provider: "mural",
        direction,
        status: "terms_of_service_required",
        termsOfServiceUrl: org.tosLink,
      };
    }
    return { provider: "mural", direction, status: "customer_verifying" };
  }
  if (org.kycLink) {
    return {
      provider: "mural",
      direction,
      status: "customer_verification_required",
      verificationUrl: org.kycLink,
    };
  }
  return { provider: "mural", direction, status: "customer_verifying" };
}

export function muralCounterpartyRequirements(
  _counterparty: Counterparty,
  { direction, country, providerData, fiatCurrency, collectedData }: ValidateCounterpartyOptions
): CounterpartyRequirements {
  if (direction === "offramp") {
    if (!fiatCurrency) {
      throw badRequest("fiatCurrency is required for Mural off-ramp requirements.");
    }
    if (fiatCurrency !== "USD") {
      return unsupportedCounterparty(
        "mural",
        direction,
        `Mural off-ramp does not yet support payouts in ${fiatCurrency}.`
      );
    }
  }
  const organization = readMuralOrganization(providerData);
  if (!organization.id) {
    const fields = addressFields(country);
    const parsed = buildRequirementSchema(fields).safeParse(collectedData);
    if (!parsed.success) {
      return { provider: "mural", direction, status: "collect", fields: [...fields] };
    }
  }
  return muralOnboardingRequirements(organization, direction);
}
