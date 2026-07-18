import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import {
  ensureLinkedOrg,
  getBootstrapApiBaseUrl,
  resolvePlaywrightProjectId,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";

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
    let releaseRsc: () => void = () => {};
    const rscGate = new Promise<void>((resolve) => {
      releaseRsc = resolve;
    });
    let interceptedRsc = false;

    await page.route(/\/dashboard\/wallets(?:\?.*)?$/, async (route) => {
      if (route.request().headers().rsc !== "1") {
        await route.continue();
        return;
      }

      interceptedRsc = true;
      await rscGate;
      await route.continue();
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1);

    const navigation = page
      .getByRole("link", { name: "Wallets", exact: true })
      .click({ noWaitAfter: true });

    try {
      await expect.poll(() => interceptedRsc, { timeout: 10_000 }).toBe(true);
      const pendingNavigation = page.locator("[data-dashboard-navigation-pending]");
      await expect(pendingNavigation).toBeVisible({ timeout: 1_000 });
      await expect(pendingNavigation).toHaveAttribute(
        "data-dashboard-navigation-pending",
        "wallets"
      );
      await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(0);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "true");
    } finally {
      releaseRsc();
    }

    await navigation;
    await expect(page).toHaveURL(/\/dashboard\/wallets(?:\?.*)?$/, { timeout: 120_000 });
    await expect(page.locator("[data-dashboard-page-content]")).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  });
});
