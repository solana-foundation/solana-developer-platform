import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { registerEarnCorePaths } from "./earn-core";
import { registerEarnOnboardingPaths } from "./earn-onboarding";

/** Core strategy actions and permissioned-asset eligibility are internal. */
export function registerEarnPaths(registry: OpenAPIRegistry) {
  registerEarnCorePaths(registry);
  registerEarnOnboardingPaths(registry);
}
