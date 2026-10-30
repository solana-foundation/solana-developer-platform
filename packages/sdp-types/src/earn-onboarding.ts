/** SDP's durable onboarding state; provider review status remains an open string. */
export const EARN_ONBOARDING_STATES = ["claimed", "linked", "archived"] as const;
export type EarnOnboardingState = (typeof EARN_ONBOARDING_STATES)[number];
