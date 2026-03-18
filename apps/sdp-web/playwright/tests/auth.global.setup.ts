import fs from "node:fs";
import path from "node:path";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test as setup } from "@playwright/test";
import { getE2EEnv } from "../env";
import { ensureClerkAdminUser } from "../support/clerk-admin";
import { clearIssuanceFixtures } from "../support/issuance-fixtures";
import {
  bootstrapLocalIssuanceFixtures,
  getBootstrapClerkJwtTemplate,
  seedLocalClerkOrganizationMapping,
} from "../support/local-issuance-bootstrap";

const authFile = path.join(__dirname, "../.clerk/user.json");

setup("authenticate admin test user and save auth state", async ({ page }) => {
  const env = getE2EEnv();
  clearIssuanceFixtures();
  const identity = await ensureClerkAdminUser();
  seedLocalClerkOrganizationMapping(identity);

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

  const bearerToken = await page.evaluate(
    async ({ template }) => {
      const clerkClient = (
        window as unknown as {
          Clerk?: {
            session?: {
              getToken: (params?: { template?: string }) => Promise<string | null>;
            };
          };
        }
      ).Clerk;

      if (!clerkClient?.session) {
        throw new Error("Clerk session is unavailable in Playwright global setup");
      }

      return clerkClient.session.getToken({ template });
    },
    { template: getBootstrapClerkJwtTemplate() }
  );

  if (!bearerToken) {
    throw new Error("Failed to acquire a Clerk JWT for the local SDP API bootstrap");
  }

  await bootstrapLocalIssuanceFixtures({
    identity,
    bearerToken,
  });

  await page.goto("/dashboard/issuance");
  await expect(page.getByRole("button", { name: "Create token" })).toBeVisible();
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  await page.context().storageState({ path: authFile });
});
