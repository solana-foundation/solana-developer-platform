import fs from "node:fs";
import path from "node:path";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test as setup } from "@playwright/test";
import { getE2EEnv } from "../env";
import { authStatePath } from "../support/auth-state";
import { resolveClerkTestIdentity, withTransientClerkRetry } from "../support/clerk-admin";

setup("authenticate admin test user and save auth state", async ({ page, browser }) => {
  setup.setTimeout(360_000);
  const env = getE2EEnv();
  const identity = await resolveClerkTestIdentity();

  // The ticket flow runs in a manually created context: Playwright tracing only
  // instruments fixture contexts, so the live sign-in token never enters the
  // retain-on-failure trace that gets uploaded as a workflow artifact.
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
    await target.goto("/sign-in", { waitUntil: "domcontentloaded" });
    await target.waitForFunction(
      () => Boolean((window as unknown as { Clerk?: { client?: unknown } }).Clerk?.client),
      undefined,
      { timeout: 120_000 }
    );
    await target.evaluate(
      async ({ ticket, organizationId }) => {
        const clerkClient = (
          window as unknown as {
            Clerk?: {
              client: {
                signIn: {
                  create: (p: Record<string, string>) => Promise<{
                    status: string;
                    createdSessionId: string | null;
                  }>;
                };
              };
              setActive: (p: { session: string; organization?: string }) => Promise<void>;
            };
          }
        ).Clerk;
        if (!clerkClient) {
          throw new Error("Clerk failed to load in Playwright global setup");
        }
        const signIn = await clerkClient.client.signIn.create({ strategy: "ticket", ticket });
        if (signIn.status !== "complete" || !signIn.createdSessionId) {
          throw new Error(`ticket sign-in did not complete: status=${signIn.status}`);
        }
        await clerkClient.setActive({
          session: signIn.createdSessionId,
          organization: organizationId,
        });
      },
      { ticket: token, organizationId: identity.organizationId }
    );
    await target.waitForFunction(
      () => Boolean((window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session),
      undefined,
      { timeout: 30_000 }
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
          Clerk?: { setActive: (params: { organization: string }) => Promise<void> };
        }
      ).Clerk;

      if (!clerkClient) {
        throw new Error("Clerk failed to load in Playwright global setup");
      }

      await clerkClient.setActive({ organization: organizationId });
    },
    { organizationId: identity.organizationId }
  );

  await expect
    .poll(() =>
      target.evaluate(() => {
        return (
          window as unknown as {
            Clerk?: { organization?: { id?: string } };
          }
        ).Clerk?.organization?.id;
      })
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
  await expect(target).toHaveURL(/\/dashboard/);
  fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
  await target.context().storageState({ path: authStatePath });
  await ticketContext?.close();
});
