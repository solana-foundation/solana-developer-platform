import type { Browser, Page } from "@playwright/test";
import { getE2EEnv } from "../env";
import { authStatePath } from "./auth-state";
import type { ClerkTestIdentity } from "./clerk-admin";
import { ensureClerkAdminUser } from "./clerk-admin";

export async function getClerkBearerToken(page: Page): Promise<string> {
  const env = getE2EEnv();

  await page.goto("/dashboard/issuance", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => {
    const clerkClient = (
      window as unknown as {
        Clerk?: {
          session?: {
            getToken: (params?: { template?: string }) => Promise<string | null>;
          };
        };
      }
    ).Clerk;

    return Boolean(clerkClient?.session);
  });

  const token = await page.evaluate(
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
        throw new Error("Clerk session is unavailable for Playwright bootstrap");
      }

      return clerkClient.session.getToken({ template });
    },
    { template: env.clerkJwtTemplate }
  );

  if (!token) {
    throw new Error("Failed to acquire a Clerk JWT for Playwright bootstrap");
  }

  return token;
}

export async function openAuthenticatedBootstrapPage(browser: Browser): Promise<Page> {
  return browser.newPage({
    storageState: authStatePath,
  });
}

export async function getPlaywrightAdminSession(browser: Browser): Promise<{
  identity: ClerkTestIdentity;
  page: Page;
  bearerToken: string;
}> {
  const identity = await ensureClerkAdminUser();
  const page = await openAuthenticatedBootstrapPage(browser);
  const bearerToken = await getClerkBearerToken(page);

  return {
    identity,
    page,
    bearerToken,
  };
}
