import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { bootstrapLocalWalletFixtures } from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard api keys e2e", () => {
    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.getBearerToken,
        walletCount: 1,
      });
      await session.page.close();
    });

    test("user can create a selected-wallet API key and the secret is only shown once", async ({
      page,
    }) => {
      const keyName = `Playwright Selected Wallet Key ${Date.now()}`;

      await page.goto("/dashboard/api-keys");
      await page.getByRole("button", { name: "New API key" }).click();

      await page.getByLabel("Name").fill(keyName);
      await page.getByLabel("Selected wallets").check();
      await page.getByRole("checkbox").first().check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Create key" }).click();

      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await expect(page.locator("#generated-key")).toHaveValue(/^(sk_test_|sk_live_)/);

      await page.getByRole("button", { name: "Dismiss" }).click();
      await page.reload();

      await expect(page.locator("#generated-key")).toHaveCount(0);
      await expect(page.getByText("Your full key (shown once)")).toHaveCount(0);
      await expect(page.getByText(keyName)).toBeVisible();
    });
  });
