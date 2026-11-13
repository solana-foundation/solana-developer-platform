import { test as base } from "@playwright/test";
import { recordRateLimitUsage, waitForRateLimitBudget } from "./rate-limit-budget";

export * from "@playwright/test";

/**
 * Playwright's `test` for specs that drive the local dashboard as the shared Clerk
 * test user. Before each test it waits until sdp-api's per-user rate limits have room
 * for one more test, and it logs what each test used (see rate-limit-budget.ts).
 */
export const test = base.extend<{ rateLimitBudget: undefined }>({
  rateLimitBudget: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
    async ({}, use, testInfo) => {
      const label = testInfo.titlePath.slice(1).join(" › ");
      await waitForRateLimitBudget(label);
      await use(undefined);
      await recordRateLimitUsage(label, testInfo.status ?? "unknown");
    },
    { auto: true },
  ],
});
