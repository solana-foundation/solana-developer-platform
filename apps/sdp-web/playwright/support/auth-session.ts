import { type Browser, expect, type Page } from "@playwright/test";
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

export interface PlaywrightAdminSession {
  identity: ClerkTestIdentity;
  page: Page;
  bearerToken: string;
  getBearerToken: () => Promise<string>;
}

async function readClerkBearerToken(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const clerkClient = (window as unknown as ClerkWindow).Clerk;

    return clerkClient?.session?.getToken() ?? null;
  });
}

function isInterruptedNavigation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("is interrupted by another navigation");
}

export async function getClerkBearerToken(page: Page): Promise<string> {
  // The proxy's workspace-loading bounce (307 + client return) can land while
  // this goto is still in flight; the return navigation is the page we want.
  await page.goto("/dashboard/issuance", { waitUntil: "domcontentloaded" }).catch((error) => {
    if (!isInterruptedNavigation(error)) throw error;
  });
  await page.waitForURL(/\/dashboard\/issuance/, { waitUntil: "domcontentloaded" });
  let token: string | null = null;
  // The readiness gate can navigate between Clerk becoming available and the
  // token read. Retry the whole read, not a separate session-presence check.
  await expect
    .poll(
      async () => {
        token = await readClerkBearerToken(page).catch(() => null);
        return Boolean(token);
      },
      { timeout: 60_000 }
    )
    .toBe(true);

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

export async function getPlaywrightAdminSession(browser: Browser): Promise<PlaywrightAdminSession> {
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
