import { expect, type Page } from "@playwright/test";

export const CLERK_ORGANIZATION_ACTIVATION_TIMEOUT_MS = 30_000;

type ClerkActivationWindow = {
  Clerk?: {
    session?: { id?: string };
    organization?: { id?: string };
    setActive: (params: { session?: string; organization?: string }) => Promise<void>;
  };
};

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
      const clerkClient = (window as unknown as ClerkActivationWindow).Clerk;
      if (!clerkClient?.session?.id) {
        throw new Error("Clerk session not established before organization activation");
      }
      await clerkClient.setActive({
        session: clerkClient.session.id,
        organization: organizationId,
      });
    },
    { organizationId }
  );
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as unknown as ClerkActivationWindow).Clerk?.organization?.id),
      { timeout: CLERK_ORGANIZATION_ACTIVATION_TIMEOUT_MS }
    )
    .toBe(organizationId);
}
