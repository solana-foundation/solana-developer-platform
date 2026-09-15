import fs from "node:fs";
import path from "node:path";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test as setup } from "@playwright/test";
import { getE2EEnv } from "../env";
import { authStatePath } from "../support/auth-state";
import { CLERK_ORGANIZATION_ACTIVATION_TIMEOUT_MS } from "../support/clerk-activation";
import { resolveClerkTestIdentity, withTransientClerkRetry } from "../support/clerk-admin";

setup("authenticate admin test user and save auth state", async ({ page, browser }) => {
  setup.setTimeout(360_000);
  const env = getE2EEnv();
  const identity = await resolveClerkTestIdentity();

  const ticketContext = env.ticketAuth ? await browser.newContext({ baseURL: env.baseURL }) : null;
  const target = ticketContext ? await ticketContext.newPage() : page;

  if (env.ticketAuth) {
    const { token } = await withTransientClerkRetry(async () => {
      const response = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.clerkSecretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: identity.userId, expires_in_seconds: 300 }),
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`sign_in_tokens failed: ${response.status} ${await response.text()}`),
          { status: response.status }
        );
      }
      return (await response.json()) as { token: string };
    });
    const redactTicket = <T>(action: Promise<T>): Promise<T> =>
      action.catch((error: unknown) => {
        throw new Error(String(error).replaceAll(token, "[redacted-clerk-ticket]"));
      });
    await redactTicket(
      target.goto(`/sign-in?__clerk_ticket=${token}`, { waitUntil: "domcontentloaded" })
    );
    await redactTicket(
      target.waitForFunction(
        () => Boolean((window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session),
        undefined,
        { timeout: 120_000 }
      )
    );
  } else {
    await clerkSetup({
      publishableKey: env.clerkPublishableKey,
      secretKey: env.clerkSecretKey,
    });

    await target.goto("/sign-in");
    await clerk.signIn({ page: target, emailAddress: identity.email });
    await clerk.loaded({ page: target });
  }

  await target.evaluate(
    async ({ organizationId }) => {
      const clerkClient = (
        window as unknown as {
          Clerk?: {
            session?: { id?: string };
            setActive: (params: { session?: string; organization?: string }) => Promise<void>;
          };
        }
      ).Clerk;

      if (!clerkClient?.session?.id) {
        throw new Error("Clerk session not established in Playwright global setup");
      }

      await clerkClient.setActive({
        session: clerkClient.session.id,
        organization: organizationId,
      });
    },
    { organizationId: identity.organizationId }
  );

  await expect
    .poll(
      () =>
        target.evaluate(() => {
          return (
            window as unknown as {
              Clerk?: { organization?: { id?: string } };
            }
          ).Clerk?.organization?.id;
        }),
      { timeout: CLERK_ORGANIZATION_ACTIVATION_TIMEOUT_MS }
    )
    .toBe(identity.organizationId);

  if (env.useExternalApi) {
    await target.context().addCookies([
      {
        name: "sdp_selected_project_id",
        value: env.expectedProjectId,
        url: env.baseURL,
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
      },
    ]);
  }

  await target.goto(env.useExternalApi ? "/dashboard" : "/dashboard/issuance");
  // Local suites seed the SDP organization in beforeAll, after this auth-only
  // setup. A Clerk session without that mapping must stop at the sync gate.
  await expect(target).toHaveURL(
    env.useExternalApi ? /\/dashboard/ : /\/(dashboard|workspace-loading)(?:[/?]|$)/
  );
  fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
  await target.context().storageState({ path: authStatePath });
  await ticketContext?.close();
});
