import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient } from "../support/local-api-client";
import { createExternalSolanaAddress } from "../support/local-dashboard-bootstrap";
import {
  bootstrapLocalIssuanceFixtures,
  getBootstrapApiBaseUrl,
} from "../support/local-issuance-bootstrap";

test.describe
  .serial("dashboard payments e2e", () => {
    let destinationAddress = "";
    let sourceWalletLabel = "";
    let sourceWalletId = "";
    let transferTokenSymbol = "";

    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalIssuanceFixtures({
        identity: session.identity,
        bearerToken: session.bearerToken,
        tier: "enterprise",
      });
      const api = createLocalApiClient(getBootstrapApiBaseUrl(), session.bearerToken);

      await api.post(`/v1/issuance/tokens/${fixtures.tokens.open.id}/mint`, {
        mint: {
          destination: fixtures.wallets.treasury.publicKey,
          amount: "25",
        },
      });

      sourceWalletLabel = fixtures.wallets.treasury.label ?? fixtures.wallets.treasury.publicKey;
      sourceWalletId = fixtures.wallets.treasury.walletId;
      transferTokenSymbol = fixtures.tokens.open.symbol;
      destinationAddress = await createExternalSolanaAddress();
      await api.put(`/v1/payments/wallets/${sourceWalletId}/policies`, {
        destinationAllowlist: [destinationAddress],
      });
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

      const walletSelect = app.getByRole("combobox", { name: "Source wallet" });
      await walletSelect.click();
      await page.getByRole("option").filter({ hasText: sourceWalletLabel }).first().click();

      const assetSelect = app.getByRole("combobox", { name: "Asset" });
      await assetSelect.click();
      await expect(page.getByRole("option", { name: "SOL", exact: true })).toHaveCount(0);
      await page.getByRole("option", { name: transferTokenSymbol, exact: true }).click();
      await expect(assetSelect).toContainText(transferTokenSymbol);
      await app.getByLabel("Amount").fill("1");
      await app.getByLabel("Destination address").fill(destinationAddress);
      await expect(
        app.getByText("This destination is already on the source wallet allowlist.")
      ).toBeVisible({ timeout: 120_000 });

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
      await expect(transferRow).toContainText("1.00");
    });
  });
