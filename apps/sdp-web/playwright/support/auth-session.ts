import type { Browser, Page } from "@playwright/test";
import { getE2EEnv } from "../env";
import { authStatePath } from "./auth-state";
import type { ClerkTestIdentity } from "./clerk-admin";
import { ensureClerkAdminUser } from "./clerk-admin";

async function readClerkBearerToken(page: Page, template: string): Promise<string | null> {
  return page.evaluate(
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

      return clerkClient?.session?.getToken({ template }) ?? null;
    },
    { template }
  );
}

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

  const token = await readClerkBearerToken(page, env.clerkJwtTemplate);

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

export function createClerkBearerTokenProvider(page: Page): () => Promise<string> {
  return async () => {
    const env = getE2EEnv();
    const token = await readClerkBearerToken(page, env.clerkJwtTemplate).catch(() => null);
    if (token) {
      return token;
    }

    return getClerkBearerToken(page);
  };
}

export async function getPlaywrightAdminSession(browser: Browser): Promise<{
  identity: ClerkTestIdentity;
  page: Page;
  bearerToken: string;
  getBearerToken: () => Promise<string>;
}> {
  const identity = await ensureClerkAdminUser();
  const page = await openAuthenticatedBootstrapPage(browser);
  const bearerToken = await getClerkBearerToken(page);
  const getBearerToken = createClerkBearerTokenProvider(page);

  return {
    identity,
    page,
    bearerToken,
    getBearerToken,
  };
}
