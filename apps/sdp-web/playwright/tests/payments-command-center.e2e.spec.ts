import { expect } from "@playwright/test";
import { test } from "@/playwright/support/test";
import { gotoProjectPage, provisionLinkedOrgProjects } from "../support/local-dashboard-bootstrap";

test.describe("payments transaction ledger", () => {
  let projectId = "";

  test.beforeAll(async ({ browser }) => {
    projectId = (await provisionLinkedOrgProjects(browser)).sandbox;
  });

  test("sends a search to the API, keeps it in a shareable URL, and fits a phone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoProjectPage(page, projectId, "/dashboard/payments/transactions");

    const search = page.getByRole("searchbox", { name: /search transactions/i });
    await expect(search).toBeVisible();
    const searched = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/dashboard/payments/transactions" &&
        url.searchParams.get("search") === "invoice-42"
      );
    });
    await search.fill("invoice-42");
    await search.press("Enter");
    expect((await searched).status()).toBe(200);
    await expect(page).toHaveURL(/[?&]search=invoice-42(&|$)/, { timeout: 5_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.reload();
    await expect(page.getByRole("searchbox", { name: /search transactions/i })).toHaveValue(
      "invoice-42"
    );
  });

  test("keeps a collapsed sidebar section collapsed across a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoProjectPage(page, projectId, "/dashboard/payments/transactions");

    const paymentsToggle = page.getByRole("button", { name: /payments menu/i });
    await expect(paymentsToggle).toHaveAttribute("aria-expanded", "true");
    await paymentsToggle.click();
    await expect(paymentsToggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(page.getByRole("button", { name: /payments menu/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });
});
