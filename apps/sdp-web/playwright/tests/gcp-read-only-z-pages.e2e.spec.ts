import { expect, test } from "@playwright/test";
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

test.describe("GCP dev dashboard read-only page sweep", () => {
  test("dashboard pages render without server errors", async ({ page }) => {
    test.setTimeout(240_000);
    const env = getE2EEnv();
    if (!env.useExternalApi) {
      throw new Error("GCP smoke must run in explicit external mode");
    }
    await seedProjectCookie(page, env.expectedProjectId);

    const failures: string[] = [];
    let currentPath = "";
    page.on("pageerror", (error) => failures.push(`${currentPath} page: ${error.message}`));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === new URL(env.baseURL).origin && response.status() >= 500) {
        failures.push(`${currentPath} ${response.status()} ${url.pathname}`);
      }
    });

    for (const path of READ_ONLY_PAGES) {
      currentPath = path;
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      if ((response?.status() ?? 0) >= 400) {
        failures.push(`${path} status ${response?.status()}`);
        continue;
      }
      await expect(page, `${path} stayed authenticated`).not.toHaveURL(/sign-in/);
      await expect(page.getByRole("heading").first(), `${path} rendered a heading`).toBeVisible({
        timeout: 20_000,
      });
      await page.waitForTimeout(4_000);
    }

    expect(failures, "page sweep server failures").toEqual([]);
  });
});
