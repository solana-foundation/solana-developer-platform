import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient } from "../support/local-api-client";
import {
  createExternalSolanaAddress,
  seedCounterpartyWithSolanaAccount,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";
import {
  bootstrapLocalIssuanceFixtures,
  getBootstrapApiBaseUrl,
} from "../support/local-issuance-bootstrap";

test.describe
  .serial("dashboard payments e2e", () => {
    let destinationAddress = "";
    let counterpartyName = "";
    let accountLabel = "";
    let sourceWalletLabel = "";
    let sourceWalletId = "";
    let transferTokenSymbol = "";
    let bootstrapProjectId = "";

    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalIssuanceFixtures({
        identity: session.identity,
        bearerToken: session.bearerToken,
        tier: "enterprise",
      });
      const api = createLocalApiClient(
        getBootstrapApiBaseUrl(),
        session.bearerToken,
        fixtures.projectId
      );

      await api.post(`/v1/issuance/tokens/${fixtures.tokens.open.id}/mint`, {
        mint: {
          destination: fixtures.wallets.treasury.publicKey,
          amount: "25",
        },
      });

      sourceWalletLabel = fixtures.wallets.treasury.label ?? fixtures.wallets.treasury.publicKey;
      sourceWalletId = fixtures.wallets.treasury.walletId;
      transferTokenSymbol = fixtures.tokens.open.symbol;
      bootstrapProjectId = fixtures.projectId;

      destinationAddress = await createExternalSolanaAddress();
      const suffix = randomUUID().slice(0, 8);
      counterpartyName = `E2E Payee ${suffix}`;
      accountLabel = `E2E Solana ${suffix}`;
      await seedCounterpartyWithSolanaAccount(api, {
        displayName: counterpartyName,
        email: `e2e-payee-${suffix}@example.com`,
        accountLabel,
        destinationAddress,
      });

      await api.put(`/v1/payments/wallets/${sourceWalletId}/policies`, {
        destinationAllowlist: [destinationAddress],
      });
      await session.page.close();
    });

    test.beforeEach(async ({ page }) => {
      await seedProjectCookie(page, bootstrapProjectId);
    });

    test("user can submit a wallet transfer and see it in recent transactions", async ({
      page,
    }) => {
      const app = page.locator("main");
      const next = app.getByRole("button", { name: "Next", exact: true });

      await page.goto("/dashboard/payments/pay");

      await app.getByRole("button", { name: "Counterparty", exact: true }).click();
      await page.getByPlaceholder("Search counterparties").fill(counterpartyName);
      await page.getByRole("button", { name: counterpartyName }).click();
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      const onchainMethod = app.getByRole("button", { name: "Onchain transfer" });
      const destinationSelect = app.getByRole("button", { name: "Destination account" });
      await expect(onchainMethod.or(destinationSelect)).toBeVisible({ timeout: 120_000 });
      if (await onchainMethod.isVisible()) {
        await onchainMethod.click();
        await expect(next).toBeEnabled();
        await next.click();
      }

      await destinationSelect.click();
      await page.getByRole("button", { name: accountLabel }).click();
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      await app.getByRole("button", { name: "Source wallet" }).click();
      await page.getByPlaceholder("Search wallets").fill(sourceWalletLabel);
      await page.getByRole("button", { name: sourceWalletLabel }).click();

      await app.getByRole("button", { name: "Asset" }).click();
      await page.getByRole("button", { name: transferTokenSymbol, exact: true }).click();

      await app.getByLabel("Amount", { exact: true }).fill("1");
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      await expect(app.getByText("Review transfer")).toBeVisible();
      const sendButton = app.getByRole("button", { name: "Send transfer", exact: true });
      await expect(sendButton).toBeEnabled({ timeout: 120_000 });
      await sendButton.click();

      await expect(app.getByText("Transfer submitted")).toBeVisible({ timeout: 120_000 });
      await app.getByRole("button", { name: "Done", exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard\/payments(?:\?.*)?$/);

      const transferRow = app.locator("tbody tr").filter({ hasText: destinationAddress }).first();
      await expect(transferRow).toBeVisible({ timeout: 120_000 });
      await expect(transferRow).toContainText("1.00");
    });
  });
