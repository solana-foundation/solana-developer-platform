import type { Browser, Page } from "@playwright/test";
import { authStatePath } from "./auth-state";
import type { ClerkTestIdentity } from "./clerk-admin";
import { resolveClerkTestIdentity } from "./clerk-admin";

type ClerkWindow = {
  Clerk?: {
    session?: {
      getToken: () => Promise<string | null>;
    };
  };
};

async function readClerkBearerToken(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const clerkClient = (window as unknown as ClerkWindow).Clerk;

    return clerkClient?.session?.getToken() ?? null;
  });
}

export async function getClerkBearerToken(page: Page): Promise<string> {
  await page.goto("/dashboard/issuance", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => {
    const clerkClient = (window as unknown as ClerkWindow).Clerk;

    return Boolean(clerkClient?.session);
  });

  const token = await readClerkBearerToken(page);

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
    const token = await readClerkBearerToken(page).catch(() => null);
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
  const identity = await resolveClerkTestIdentity();
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
