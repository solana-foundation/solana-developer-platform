import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { registerEarnCorePaths } from "./earn-core";
import { registerEarnOnboardingPaths } from "./earn-onboarding";

/** All Earn routes, including internal provider eligibility. */
export function registerEarnPaths(registry: OpenAPIRegistry) {
  registerEarnCorePaths(registry);
  registerEarnOnboardingPaths(registry);
}

/** Partner strategy actions use the same contract and release-channel gate. */
export function registerPublicEarnPaths(registry: OpenAPIRegistry) {
  registerEarnCorePaths(registry, true);
}
