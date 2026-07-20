import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import {
  ensureLinkedOrg,
  getBootstrapApiBaseUrl,
  resolvePlaywrightProjectId,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";

test.describe("payments command center and transaction ledger", () => {
  let projectId = "";

  test.beforeAll(async ({ browser }) => {
    const session = await getPlaywrightAdminSession(browser);
    await ensureLinkedOrg(session.identity, { tier: "enterprise" });
    projectId = await resolvePlaywrightProjectId(getBootstrapApiBaseUrl(), session.getBearerToken);
    await session.page.close();
  });

  test.beforeEach(async ({ page }) => {
    await seedProjectCookie(page, projectId);
  });

  test("renders the fast action surface and independently settled summaries", async ({ page }) => {
    await page.goto("/dashboard/payments", { waitUntil: "domcontentloaded" });

    const commandCenter = page.locator("[data-payments-command-center]");
    await expect(commandCenter).toBeVisible();
    const destinations = [
      ["Pay", "/dashboard/payments/pay"],
      ["Deposit", "/dashboard/payments/deposit"],
      ["Request payment", "/dashboard/payments/requests"],
      ["Schedule", "/dashboard/payments/recurring/create"],
    ] as const;
    for (const [name, href] of destinations) {
      await expect(
        commandCenter.getByRole("link", { name: new RegExp(`^${name}`) })
      ).toHaveAttribute("href", href);
    }

    for (const section of ["balance", "activity", "upcoming", "network"]) {
      await expect(
        commandCenter.locator(`[data-payments-overview-section="${section}"]`)
      ).toBeVisible({
        timeout: 120_000,
      });
    }
    await expect(
      commandCenter.getByRole("link", { name: "View all transactions" })
    ).toHaveAttribute("href", "/dashboard/payments/transactions");
  });

  test("keeps transaction filters responsive, shareable, and stable on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/dashboard/payments/transactions", { waitUntil: "domcontentloaded" });

    const search = page.getByRole("textbox", { name: /search id, signature/i });
    await expect(search).toBeVisible();
    await search.fill("invoice-42");
    await expect(page).toHaveURL(/search=invoice-42/, { timeout: 5_000 });

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await expect(page.locator("[data-transaction-advanced-filters]")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.getByRole("button", { name: /open navigation/i }).click();
    const paymentsToggle = page.getByRole("button", { name: /payments menu/i });
    await expect(paymentsToggle).toHaveAttribute("aria-expanded", "true");
    await paymentsToggle.click();
    await expect(paymentsToggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await page.getByRole("button", { name: /open navigation/i }).click();
    await expect(page.getByRole("button", { name: /payments menu/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });
});
