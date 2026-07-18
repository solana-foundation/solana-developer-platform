import { expect, type Page, test } from "@playwright/test";
import { DASHBOARD_NAVIGATION_START_EVENT } from "../../src/lib/dashboard-navigation-loading";
import { getPlaywrightAdminSession } from "../support/auth-session";
import {
  ensureLinkedOrg,
  getBootstrapApiBaseUrl,
  resolvePlaywrightProjectId,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";

async function stallRsc(page: Page, routePattern: RegExp) {
  let releaseRequest: () => void = () => {};
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let markIntercepted: () => void = () => {};
  const intercepted = new Promise<void>((resolve) => {
    markIntercepted = resolve;
  });

  await page.route(routePattern, async (route) => {
    if (route.request().headers().rsc !== "1") {
      await route.continue();
      return;
    }

    markIntercepted();
    await requestGate;
    await route.continue();
  });

  return { intercepted, release: releaseRequest };
}

async function expectPendingRoute(page: Page, loadingRoute: string) {
  const pendingNavigation = page.locator("[data-dashboard-navigation-pending]");
  await expect(pendingNavigation).toBeVisible({ timeout: 1_000 });
  await expect(pendingNavigation).toHaveAttribute(
    "data-dashboard-navigation-pending",
    loadingRoute
  );
  await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(0);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "true");
}

test.describe("dashboard navigation loading contract", () => {
  let projectId = "";

  test.beforeAll(async ({ browser }) => {
    const session = await getPlaywrightAdminSession(browser);
    await ensureLinkedOrg(session.identity);
    projectId = await resolvePlaywrightProjectId(getBootstrapApiBaseUrl(), session.getBearerToken);
    await session.page.close();
  });

  test.beforeEach(async ({ page }) => {
    await seedProjectCookie(page, projectId);
  });

  test("immediately replaces the prior page while the destination RSC is stalled", async ({
    page,
  }) => {
    const stalledRsc = await stallRsc(page, /\/dashboard\/wallets(?:\?.*)?$/);

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1);

    const navigation = page
      .getByRole("link", { name: "Wallets", exact: true })
      .click({ noWaitAfter: true });

    try {
      await stalledRsc.intercepted;
      await expectPendingRoute(page, "wallets-overview");
    } finally {
      stalledRsc.release();
      await navigation;
    }

    await expect(page).toHaveURL(/\/dashboard\/wallets(?:\?.*)?$/, { timeout: 120_000 });
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  });

  test("gives an in-content dashboard link the same precommit feedback", async ({ page }) => {
    const stalledRsc = await stallRsc(page, /\/dashboard\/wallets(?:\?.*)?$/);

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const pageContent = page.locator("[data-dashboard-page-content]");
    await expect(pageContent).toHaveCount(1);

    const inContentWalletLink = pageContent.locator(
      // biome-ignore lint/security/noSecrets: Static DOM selector, not a credential.
      '[data-dashboard-navigation-link="true"][href="/dashboard/wallets"]'
    );
    const navigation = inContentWalletLink.click({ noWaitAfter: true });

    try {
      await stalledRsc.intercepted;
      await expectPendingRoute(page, "wallets-overview");
    } finally {
      stalledRsc.release();
      await navigation;
    }

    await expect(page).toHaveURL(/\/dashboard\/wallets(?:\?.*)?$/, { timeout: 120_000 });
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  });

  test("keeps the current page visible when a managed link cancels navigation", async ({
    page,
  }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1);

    const walletsLink = page.getByRole("link", { name: "Wallets", exact: true });
    await walletsLink.evaluate((link) => {
      link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    });

    await walletsLink.click({ noWaitAfter: true });

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("[data-dashboard-navigation-pending]")).toHaveCount(0);
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1);
  });

  test("uses the exact subnav loading surface before Requests commits", async ({ page }) => {
    const stalledRsc = await stallRsc(page, /\/dashboard\/payments\/requests(?:\?.*)?$/);
    await page.goto("/dashboard/payments", { waitUntil: "domcontentloaded" });

    const navigation = page.getByRole("link", { name: "Requests", exact: true }).click({
      noWaitAfter: true,
    });

    try {
      await stalledRsc.intercepted;
      await expectPendingRoute(page, "payment-requests");
    } finally {
      stalledRsc.release();
      await navigation;
    }

    await expect(page).toHaveURL(/\/dashboard\/payments\/requests(?:\?.*)?$/);
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1);
  });

  test("gives programmatic router navigation immediate exact feedback", async ({ page }) => {
    const stalledRsc = await stallRsc(page, /\/dashboard\/wallets\/setup(?:\?.*)?$/);
    await page.goto("/dashboard/wallets", { waitUntil: "domcontentloaded" });

    const navigation = page
      .getByRole("button", { name: "Create Wallet", exact: true })
      .first()
      .click({ noWaitAfter: true });

    try {
      await stalledRsc.intercepted;
      await expectPendingRoute(page, "wallet-setup");
    } finally {
      stalledRsc.release();
      await navigation;
    }

    await expect(page).toHaveURL(/\/dashboard\/wallets\/setup(?:\?.*)?$/);
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1);
  });

  test("recovers the prior page when a programmatic navigation never commits", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1);

    await page.evaluate((eventName) => {
      window.dispatchEvent(
        new CustomEvent(eventName, {
          detail: {
            fromPathname: "/dashboard",
            toPathname: "/dashboard/wallets",
          },
        })
      );
    }, DASHBOARD_NAVIGATION_START_EVENT);

    await expectPendingRoute(page, "wallets-overview");
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1, {
      timeout: 11_000,
    });
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  });
});
