import type { Counterparty } from "@sdp/types";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import { badRequest, unsupportedCounterparty } from "../../../errors";
import { readyCounterparty } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  isMuralTosAccepted,
  type MuralOrganizationResolution,
  readMuralOrganization,
} from "./provider-data";

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
  { direction, providerData, fiatCurrency }: ValidateCounterpartyOptions
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
  return muralOnboardingRequirements(readMuralOrganization(providerData), direction);
}
