// The import brings in @clerk/testing's global `window.Clerk` type, which the
// browser callbacks below read.
import "@clerk/testing/playwright";
import { expect, type Page } from "@playwright/test";

export const CLERK_ORGANIZATION_ACTIVATION_TIMEOUT_MS = 30_000;

/**
 * Makes `organizationId` the active organization of the page's Clerk session
 * and waits until Clerk reports it.
 *
 * Call it after every sign-in. All runs share one Clerk test user, and a new
 * session opens in whichever organization Clerk picks for that user, which can
 * be another run's fixture organization that this run's database never
 * provisioned. On a dev instance every context restored from the saved auth
 * state shares one Clerk client, so a session left in the wrong organization
 * also leaks into later specs.
 *
 * @param page - A page Clerk has just signed in.
 * @param organizationId - The Clerk organization the test expects.
 * @throws When the page has no Clerk session, or the organization never becomes active.
 */
export async function activateClerkOrganization(page: Page, organizationId: string): Promise<void> {
  await page.evaluate(
    async ({ organizationId }) => {
      const sessionId = window.Clerk.session?.id;
      if (!sessionId) {
        throw new Error("Clerk session not established before organization activation");
      }
      await window.Clerk.setActive({ session: sessionId, organization: organizationId });
    },
    { organizationId }
  );
  await expect
    .poll(() => page.evaluate(() => window.Clerk.organization?.id), {
      timeout: CLERK_ORGANIZATION_ACTIVATION_TIMEOUT_MS,
    })
    .toBe(organizationId);
}
