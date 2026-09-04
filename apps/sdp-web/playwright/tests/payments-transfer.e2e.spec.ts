import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createLocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  createExternalSolanaAddress,
  getBootstrapApiBaseUrl,
  getPlaywrightCustodyProvider,
  provisionWithAdminSession,
  seedCounterpartyWithSolanaAccount,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard payments e2e", () => {
    let destinationAddress = "";
    let counterpartyName = "";
    let accountLabel = "";
    let deniedDestinationAddress = "";
    let deniedCounterpartyName = "";
    let deniedAccountLabel = "";
    let sourceWalletLabel = "";
    let sourceWalletId = "";
    let transferTokenSymbol = "";
    let bootstrapProjectId = "";

    test.beforeAll(async ({ browser }) => {
      bootstrapProjectId = await provisionWithAdminSession(browser, async (session) => {
        const walletBootstrap = await bootstrapLocalWalletFixtures({
          identity: session.identity,
          bearerToken: session.getBearerToken,
          provider: getPlaywrightCustodyProvider(),
          walletCount: 1,
          fundSourceWallet: true,
          fundSourceAmountSol: 0.05,
          tier: "enterprise",
        });
        const api = createLocalApiClient(
          getBootstrapApiBaseUrl(),
          session.getBearerToken,
          walletBootstrap.projectId
        );
        const sourceWallet = walletBootstrap.wallets[0];
        if (!sourceWallet) {
          throw new Error("Payment bootstrap did not create a source wallet");
        }

        if (!sourceWallet.label) {
          throw new Error("Payment bootstrap source wallet did not return its seeded label");
        }
        sourceWalletLabel = sourceWallet.label;
        sourceWalletId = sourceWallet.walletId;
        transferTokenSymbol = "SOL";

        destinationAddress = await createExternalSolanaAddress();
        const suffix = randomUUID().slice(0, 8);
        counterpartyName = `E2E Payee ${suffix}`;
        accountLabel = `E2E Solana ${suffix}`;
        await seedCounterpartyWithSolanaAccount(api, {
          displayName: counterpartyName,
          accountLabel,
          destinationAddress,
        });

        deniedDestinationAddress = await createExternalSolanaAddress();
        deniedCounterpartyName = `E2E Blocked Payee ${suffix}`;
        deniedAccountLabel = `E2E Blocked Solana ${suffix}`;
        await seedCounterpartyWithSolanaAccount(api, {
          displayName: deniedCounterpartyName,
          accountLabel: deniedAccountLabel,
          destinationAddress: deniedDestinationAddress,
        });

        await api.put(`/v1/payments/wallets/${sourceWalletId}/policies`, {
          defaultAction: "allow",
          rules: [
            {
              id: "allowlist-destinations",
              kind: "destination",
              allowlist: [destinationAddress],
              action: "allow",
              name: "Allowed destinations",
            },
          ],
        });
        return walletBootstrap.projectId;
      });
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

      await app.getByLabel("Amount", { exact: true }).fill("0.01");
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      await expect(app.getByText("Review transfer")).toBeVisible();
      const sendButton = app.getByRole("button", { name: "Send transfer", exact: true });
      await expect(sendButton).toBeEnabled({ timeout: 120_000 });
      await sendButton.click();

      await expect(app.getByText("Transfer submitted")).toBeVisible({ timeout: 120_000 });
      const doneButton = app.getByRole("button", { name: "Done", exact: true });
      await doneButton.focus();
      await doneButton.press("Enter");
      await expect(page).toHaveURL(/\/dashboard\/payments(?:\?.*)?$/);

      const shortenedDestination = `${destinationAddress.slice(0, 6)}…${destinationAddress.slice(-4)}`;
      const transferRow = app.getByRole("link").filter({ hasText: shortenedDestination }).first();
      await expect(transferRow).toBeVisible({ timeout: 120_000 });
      await expect(transferRow).toContainText("0.01");
    });

    test("wallet policy denies a transfer to a non-allowlisted destination", async ({ page }) => {
      const app = page.locator("main");
      const next = app.getByRole("button", { name: "Next", exact: true });

      await page.goto("/dashboard/payments/pay");

      await app.getByRole("button", { name: "Counterparty", exact: true }).click();
      await page.getByPlaceholder("Search counterparties").fill(deniedCounterpartyName);
      await page.getByRole("button", { name: deniedCounterpartyName }).click();
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
      await page.getByRole("button", { name: deniedAccountLabel }).click();
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      await app.getByRole("button", { name: "Source wallet" }).click();
      await page.getByPlaceholder("Search wallets").fill(sourceWalletLabel);
      await page.getByRole("button", { name: sourceWalletLabel }).click();

      await app.getByRole("button", { name: "Asset" }).click();
      await page.getByRole("button", { name: transferTokenSymbol, exact: true }).click();

      await app.getByLabel("Amount", { exact: true }).fill("0.01");
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      await expect(app.getByText("Review transfer")).toBeVisible();
      const sendButton = app.getByRole("button", { name: "Send transfer", exact: true });
      await expect(sendButton).toBeEnabled({ timeout: 120_000 });

      const transferResponsePromise = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/dashboard/payments/transfers" &&
          response.request().method() === "POST",
        { timeout: 120_000 }
      );
      await sendButton.click();

      const transferResponse = await transferResponsePromise;
      expect(transferResponse.status()).toBe(403);
      const transferBody = (await transferResponse.json()) as {
        error?: { code?: string; message?: string };
      };
      expect(transferBody.error?.code).toBe("FORBIDDEN");
      expect(transferBody.error?.message).toBe("Wallet operation denied by policy");

      await expect(page.getByText("Transfer failed.", { exact: true })).toBeVisible({
        timeout: 120_000,
      });
      await expect(page.getByText(/Wallet operation denied by policy/)).toBeVisible();
      await expect(app.getByText("Transfer submitted")).not.toBeVisible();

      await page.goto("/dashboard/payments");
      const allowedShortened = `${destinationAddress.slice(0, 6)}…${destinationAddress.slice(-4)}`;
      await expect(app.getByRole("link").filter({ hasText: allowedShortened }).first()).toBeVisible(
        { timeout: 120_000 }
      );
      const deniedShortened = `${deniedDestinationAddress.slice(0, 6)}…${deniedDestinationAddress.slice(-4)}`;
      await expect(app.getByRole("link").filter({ hasText: deniedShortened })).toHaveCount(0);
    });
  });
