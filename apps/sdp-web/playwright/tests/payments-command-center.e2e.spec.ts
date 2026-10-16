import { expect, test } from "@playwright/test";
import { projectHref } from "@/lib/dashboard-project-path";
import { gotoProjectPage, provisionLinkedOrgProjects } from "../support/local-dashboard-bootstrap";

test.describe("payments command center and transaction ledger", () => {
  let projectId = "";

  test.beforeAll(async ({ browser }) => {
    projectId = (await provisionLinkedOrgProjects(browser)).sandbox;
  });

  test("renders the fast action surface and independently settled summaries", async ({ page }) => {
    await gotoProjectPage(page, projectId, "/dashboard/payments");

    const commandCenter = page.locator("[data-payments-command-center]");
    await expect(commandCenter).toBeVisible();
    const destinations = [
      ["Pay", "/dashboard/payments/pay"],
      ["Deposit", "/dashboard/payments/deposit"],
      ["Request", "/dashboard/payments/requests"],
      ["Schedule", "/dashboard/payments/recurring/create"],
    ] as const;
    for (const [name, href] of destinations) {
      await expect(
        commandCenter.getByRole("link", { name: new RegExp(`^${name}`) })
      ).toHaveAttribute("href", projectHref(projectId, href));
    }

    for (const section of ["balance", "summary", "actions", "activity"]) {
      await expect(
        commandCenter.locator(`[data-payments-overview-section="${section}"]`)
      ).toBeVisible({
        timeout: 120_000,
      });
    }
    // With transfers the activity list ends on "View all transactions"; a project with none
    // shows the empty state, whose one way on is "Open Transactions".
    await expect(
      commandCenter
        .locator('[data-payments-overview-section="activity"]')
        .getByRole("link", { name: /^(View all transactions|Open Transactions)$/ })
        .first()
    ).toHaveAttribute("href", projectHref(projectId, "/dashboard/payments/transactions"));
  });

  test("keeps transaction filters responsive, shareable, and stable on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoProjectPage(page, projectId, "/dashboard/payments/transactions");

    // new-design-activity renders the search as a searchbox; the previous design's is a textbox.
    const search = page
      .getByRole("searchbox", { name: /search transactions/i })
      .or(page.getByRole("textbox", { name: /search transactions/i }));
    await expect(search).toBeVisible();
    await search.fill("invoice-42");
    await search.press("Enter");
    await expect(page).toHaveURL(/search=invoice-42/, { timeout: 5_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    // The payments sub-nav lives in the persistent sidebar, which only exists at xl
    // and above — mobile navigation is the bottom bar now, and its More sheet does
    // not repeat a menu the Payments page already carries.
    await page.setViewportSize({ width: 1440, height: 900 });
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
