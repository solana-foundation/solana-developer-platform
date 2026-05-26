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
  return entityType === "individual"
    ? ["basics", "identity", "address", "review"]
    : ["basics", "address", "review"];
}
