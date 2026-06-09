import type { CounterpartyEntityType } from "@sdp/types";
import type {
  AddressData,
  BasicsData,
  ComplianceData,
  IdentityData,
  StepId,
} from "./counterparty-create-schemas";

export const KYC_REQUIRED_COUNTRY_CODE = "US";

export const defaultBasics: BasicsData = {
  entityType: "individual",
  displayName: "",
  email: "",
  externalId: "",
};

export const defaultIdentity: IdentityData = {
  firstName: "",
  lastName: "",
  dateOfBirth: "",
  phone: "",
};

export const defaultAddress: AddressData = {
  line1: "",
  line2: "",
  city: "",
  postalCode: "",
  countryCode: "",
  subdivisionCode: "",
};

export const defaultCompliance: ComplianceData = {
  taxIdNumber: "",
  nationality: "",
  birthCountryCode: "",
  employmentStatus: "",
  sourceOfFunds: "",
  pepStatus: "",
  intendedUseOfAccount: "",
  estimatedYearlyIncome: "",
  employmentIndustrySector: "",
  expectedMonthlyVolume: "",
};

export function requiresCompliance(
  entityType: CounterpartyEntityType,
  countryCode: string
): boolean {
  return (
    entityType === "individual" && countryCode.trim().toUpperCase() === KYC_REQUIRED_COUNTRY_CODE
  );
}

export function getSteps(entityType: CounterpartyEntityType, countryCode: string): StepId[] {
  if (entityType !== "individual") {
    return ["basics", "address", "review"];
  }
  return requiresCompliance(entityType, countryCode)
    ? ["basics", "identity", "address", "compliance", "review"]
    : ["basics", "identity", "address", "review"];
}
