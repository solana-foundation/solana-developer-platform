import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import {
  bootstrapLocalWalletFixtures,
  ensureLinkedOrg,
} from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard wallets e2e", () => {
    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureLinkedOrg(session.identity);
      await session.page.close();
    });

    test("user can initialize Privy and run signer check from the wallet detail page", async ({
      page,
    }) => {
      await page.goto("/dashboard/wallets");

      await expect(page.getByText("Create your first wallet", { exact: true })).toBeVisible();

      const privyCard = page.locator("article").filter({
        has: page.getByRole("heading", { name: "Privy" }),
      });
      await privyCard.getByRole("button", { name: "New wallet" }).click();

      await page.getByLabel("Primary wallet label").fill("Treasury");
      await page.getByRole("button", { name: "Create wallet" }).click();

      const walletCard = page.locator("article").filter({
        has: page.getByText("Treasury"),
      });
      await expect(walletCard).toBeVisible({ timeout: 120_000 });

      await walletCard.getByRole("link", { name: "Manage" }).click();
      await expect(page).toHaveURL(/\/dashboard\/wallets\/.+/);

      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Prove ownership" }).click();

      await expect(page.getByText("Signer check sent.")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByRole("link", { name: "View on Solana Explorer" })).toBeVisible();
    });

    test("wallet activity keeps burn rows visible when refresh fails", async ({
      browser,
      page,
    }) => {
      const session = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.bearerToken,
        provider: "privy",
        walletCount: 1,
        tier: "enterprise",
      });
      await session.page.close();

      const wallet = fixtures.wallets[0];
      if (!wallet) {
        throw new Error("Failed to bootstrap wallet activity fixture");
      }

      let failNextActivityRequest = false;
      await page.route(/\/api\/dashboard\/wallets\/[^/]+\/activity$/, async (route) => {
        if (failNextActivityRequest) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: { message: "Activity refresh failed" },
            }),
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              activityRows: [
                {
                  id: "issuance-e2e-burn",
                  sourceKind: "issuance",
                  operationLabel: "Burn",
                  status: "confirmed",
                  signature: "burn_signature_e2e_111111111111111111111111111111111111",
                  token: "E2E",
                  amount: "3",
                  address: wallet.publicKey,
                  createdAt: "2024-01-02T00:00:00.000Z",
                  updatedAt: "2024-01-02T00:00:00.000Z",
                },
                {
                  id: "issuance-e2e-force-burn",
                  sourceKind: "issuance",
                  operationLabel: "Force Burn",
                  status: "confirmed",
                  signature: null,
                  token: "E2E",
                  amount: "1",
                  address: wallet.publicKey,
                  createdAt: "2024-01-01T00:00:00.000Z",
                  updatedAt: "2024-01-01T00:00:00.000Z",
                },
              ],
              activityError: null,
              activityNotice: null,
            },
          }),
        });
      });

      await page.goto(`/dashboard/wallets/${wallet.walletId}`);
      await expect(page.getByText("Burn", { exact: true })).toBeVisible({
        timeout: 120_000,
      });
      await expect(page.getByText("Force Burn", { exact: true })).toBeVisible();
      const burnRow = page.locator("tr").filter({ hasText: "3 E2E" });
      await expect(burnRow.getByRole("link")).toHaveCount(1);
      const forceBurnRow = page.locator("tr").filter({ hasText: "Force Burn" });
      await expect(forceBurnRow.getByText("Pending")).toBeVisible();
      await expect(forceBurnRow.getByRole("link")).toHaveCount(0);
      await expect(
        page.getByText("Historical burns from non-associated token accounts may be unavailable.")
      ).toHaveCount(0);

      failNextActivityRequest = true;
      await page.getByRole("button", { name: "Refresh" }).click();

      await expect(page.getByText("Activity refresh failed")).toBeVisible();
      await expect(page.getByText("Burn", { exact: true })).toBeVisible();
      await expect(page.getByText("Force Burn", { exact: true })).toBeVisible();
    });
  });
