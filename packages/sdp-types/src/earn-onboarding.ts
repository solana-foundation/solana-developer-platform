/** SDP's durable onboarding state; provider review status remains an open string. */
export const EARN_ONBOARDING_STATES = ["claimed", "linked", "archived"] as const;
export type EarnOnboardingState = (typeof EARN_ONBOARDING_STATES)[number];

/**
 * WisdomTree business application choices: keep drafting or submit for
 * provider review. Person onboarding has no draft (see wisdomtree-onboarding.md).
 */
export const WISDOM_TREE_BUSINESS_APPLICATION_STATUSES = ["draft", "submit"] as const;
export type WisdomTreeBusinessApplicationStatus =
  (typeof WISDOM_TREE_BUSINESS_APPLICATION_STATUSES)[number];
