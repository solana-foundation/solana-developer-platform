import fs from "node:fs";
import path from "node:path";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test as setup } from "@playwright/test";
import { getE2EEnv } from "../env";
import { ensureClerkAdminUser } from "../support/clerk-admin";

const authFile = path.join(__dirname, "../.clerk/user.json");

setup("authenticate admin test user and save auth state", async ({ page }) => {
  const env = getE2EEnv();
  const identity = await ensureClerkAdminUser();

  await clerkSetup({
    publishableKey: env.clerkPublishableKey,
    secretKey: env.clerkSecretKey,
  });

  await page.goto("/sign-in");
  await clerk.signIn({ page, emailAddress: identity.email });
  await clerk.loaded({ page });

  await page.evaluate(
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

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  await page.context().storageState({ path: authFile });
});
