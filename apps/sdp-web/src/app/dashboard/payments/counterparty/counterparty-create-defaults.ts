import type { BasicsData, StepId } from "./counterparty-create-schemas";

export const defaultBasics: BasicsData = {
  entityType: "individual",
  displayName: "",
  externalId: "",
};

export const COUNTERPARTY_CREATE_STEPS = ["basics", "review"] as const satisfies readonly StepId[];
