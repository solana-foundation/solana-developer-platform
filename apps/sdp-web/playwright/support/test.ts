import { test as base } from "@playwright/test";
import {
  recordRateLimitUsage,
  waitForRateLimitBudget,
} from "@/playwright/support/rate-limit-budget";

/**
 * Playwright's `test` for specs that drive the local dashboard as the shared Clerk
 * test user. Before each test it waits until sdp-api's per-user rate limits have room
 * for one more test, and it logs what each test used (see rate-limit-budget.ts).
 * Specs still import `expect` and Playwright's types from `@playwright/test`.
 */
export const test = base.extend<{ rateLimitBudget: undefined }>({
  rateLimitBudget: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
    async ({}, use, testInfo) => {
      const label = testInfo.titlePath.slice(1).join(" › ");
      await waitForRateLimitBudget(label);
      await use(undefined);
      await recordRateLimitUsage(label, testInfo.status);
    },
    { auto: true },
  ],
});
