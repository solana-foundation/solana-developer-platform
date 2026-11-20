/** Core yield actions, the operations that track them, and independent provider eligibility. */
export const EARN_GROUPS = {
  core: "Core",
  operations: "Operations",
  onboarding: "Onboarding",
} as const satisfies Record<string, string>;
