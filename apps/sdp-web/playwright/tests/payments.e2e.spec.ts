import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import {
  bootstrapLocalWalletFixtures,
  createExternalSolanaAddress,
} from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard payments e2e", () => {
    let destinationAddress = "";

    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.bearerToken,
        walletCount: 1,
        fundSourceWallet: true,
        fundSourceAmountSol: 0.02,
      });
      destinationAddress = await createExternalSolanaAddress();
      await session.page.close();
    });

    test("user can submit a wallet transfer and see it in recent transactions", async ({
      page,
    }) => {
      const app = page.locator("main");

      await page.goto("/dashboard/payments");
      await app.getByRole("button", { name: "Send" }).click();

      await expect(page).toHaveURL(/\/dashboard\/payments\/send/);
      await app.getByRole("button", { name: "Wallet transfer" }).click();
      const assetSelect = app.getByRole("combobox", { name: "Asset" });
      await assetSelect.click();
      await page.getByRole("option", { name: "SOL", exact: true }).click();
      await expect(assetSelect).toContainText("SOL");
      await app.getByLabel("Amount").fill("0.01");
      await app.getByLabel("Destination address").fill(destinationAddress);
      await app.getByRole("button", { name: "Run a risk check" }).click();

      const riskResultsDialog = page.getByText("Risk score results");
      await expect(riskResultsDialog).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: "Dismiss" }).click();
      await expect(riskResultsDialog).toHaveCount(0);

      const nextButton = app.getByRole("button", { name: "Next", exact: true });
      await expect(nextButton).toBeEnabled({ timeout: 120_000 });
      await nextButton.click();
      await expect(app.getByText("Review transfer")).toBeVisible();

      const confirmButton = app.getByRole("button", { name: "Confirm", exact: true });
      await expect(confirmButton).toBeEnabled({ timeout: 120_000 });
      await confirmButton.click();
      await expect(app.getByText("Transfer submitted")).toBeVisible({ timeout: 120_000 });

      await page.getByRole("link", { name: "Back to payments" }).click();
      await expect(page).toHaveURL(/\/dashboard\/payments(?:\?.*)?$/);

      const transferRow = app.locator("tbody tr").filter({ hasText: destinationAddress }).first();
      await expect(transferRow).toBeVisible({ timeout: 120_000 });
      await expect(transferRow.getByText("0.01 SOL")).toBeVisible();
    });
  });
