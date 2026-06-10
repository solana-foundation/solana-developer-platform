import type { CounterpartyEntityType } from "@sdp/types";
import type { AddressData, BasicsData, IdentityData, StepId } from "./counterparty-create-schemas";

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

export function getSteps(entityType: CounterpartyEntityType): StepId[] {
  if (entityType !== "individual") {
    return ["basics", "address", "review"];
  }
  return ["basics", "identity", "address", "review"];
}
