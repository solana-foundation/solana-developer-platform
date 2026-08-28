import { expect, type Page, test } from "@playwright/test";
import { getE2EEnv } from "../env";
import { seedProjectCookie } from "../support/local-dashboard-bootstrap";

const READ_ONLY_PAGES = [
  "/dashboard/tokens",
  "/dashboard/payments/counterparty",
  "/dashboard/api-keys",
  "/dashboard/policies",
  "/dashboard/members",
  "/dashboard/approvals",
  "/dashboard/custody",
  "/dashboard/settings",
];

function captureServerFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`page: ${error.message}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(getE2EEnv().baseURL).origin && response.status() >= 500) {
      failures.push(`${response.status()} ${url.pathname}`);
    }
  });
  return failures;
}

test.describe("GCP dev dashboard read-only page sweep", () => {
  test.beforeEach(async ({ page }) => {
    const env = getE2EEnv();
    if (!env.useExternalApi) {
      throw new Error("GCP smoke must run in explicit external mode");
    }
    await seedProjectCookie(page, env.expectedProjectId);
  });

  for (const path of READ_ONLY_PAGES) {
    test(`${path} renders without server errors`, async ({ page }) => {
      const failures = captureServerFailures(page);

      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(response?.status(), `${path} status`).toBeLessThan(400);
      await expect(page).not.toHaveURL(/sign-in/);
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
      expect(failures, `${path} server failures`).toEqual([]);
    });
  }
});
