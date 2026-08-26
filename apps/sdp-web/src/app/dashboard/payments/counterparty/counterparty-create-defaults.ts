import type { CounterpartyEntityType } from "@sdp/types";
import type { BasicsData, IdentityData, StepId } from "./counterparty-create-schemas";

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
};

/**
 * @param entityType - The counterparty type selected in the basics form.
 * @returns The ordered create-wizard steps for the selected counterparty type.
 */
export function getSteps(entityType: CounterpartyEntityType): StepId[] {
  if (entityType !== "individual") {
    return ["basics", "review"];
  }
  return ["basics", "identity", "review"];
}
