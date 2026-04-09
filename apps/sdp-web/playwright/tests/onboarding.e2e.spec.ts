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

    test("unlinked Clerk organization waits for webhook sync on the wallets dashboard", async ({
      page,
    }) => {
      await page.goto("/dashboard/wallets");

      await expect(page.getByText("Waiting for organization sync", { exact: true })).toBeVisible();
      await expect(page.getByText("Confirm organization details")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Confirm and link organization" })).toHaveCount(
        0
      );

      await page.reload();

      await expect(page.getByText("Waiting for organization sync", { exact: true })).toBeVisible();
      await expect(page.getByText("Confirm organization details")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Confirm and link organization" })).toHaveCount(
        0
      );
    });
  });
