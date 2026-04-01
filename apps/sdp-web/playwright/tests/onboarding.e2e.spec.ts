import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { ensureUnlinkedOrg } from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard onboarding e2e", () => {
    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureUnlinkedOrg(session.identity);
      await session.page.close();
    });

    test("user can link an unlinked Clerk organization from the wallets dashboard", async ({
      page,
    }) => {
      await page.goto("/dashboard/wallets");

      await expect(page.getByText("Confirm organization details", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Confirm and link organization" }).click();

      await expect(page.getByText("Create your first wallet", { exact: true })).toBeVisible({
        timeout: 120_000,
      });

      await page.reload();

      await expect(page.getByText("Create your first wallet", { exact: true })).toBeVisible();
      await expect(page.getByText("Confirm organization details")).toHaveCount(0);
    });
  });
