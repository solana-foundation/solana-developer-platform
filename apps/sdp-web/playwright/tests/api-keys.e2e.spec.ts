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
      await page.getByRole("link", { name: "New API key" }).click();

      await page.getByLabel("Name").fill(keyName);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("heading", { level: 2, name: "Endpoint permissions" })
      ).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByLabel("Selected wallets").check();
      await page
        .getByRole("checkbox", { name: /^Select / })
        .first()
        .check();
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByText("Key identity")).toBeVisible();
      await expect(page.getByText("Wallet-control baseline")).toBeVisible();
      await expect(page.getByText("No additional API-key restrictions").first()).toBeVisible();
      await expect(page.getByText("No policy bindings will be created").first()).toBeVisible();

      await page.getByRole("button", { name: "Create key" }).click();

      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await expect(page.locator("#generated-key")).toHaveValue(/^(sk_test_|sk_live_)/);

      await page.getByRole("button", { name: "Dismiss" }).click();
      await page.reload();

      await expect(page.locator("#generated-key")).toHaveCount(0);
      await expect(page.getByText("Your full key (shown once)")).toHaveCount(0);
      const keyRow = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(keyRow).toBeVisible({ timeout: 120_000 });
      await expect(keyRow).toContainText("Developer access");
      await expect(keyRow).toContainText("1 selected");
      await expect(keyRow).toContainText("No API-key policy");
    });

    test("user can replace and clear a restricted all-wallet binding without rotation loss", async ({
      page,
    }) => {
      const keyName = `Playwright Restricted Key ${Date.now()}`;

      await page.goto("/dashboard/api-keys");
      await page.getByRole("link", { name: "New API key" }).click();
      await page.getByLabel("Name").fill(keyName);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("switch", { name: "Add API-key restrictions" }).click();
      await page.getByRole("checkbox", { name: "Raw signing" }).check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Create key" }).click();

      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: "Dismiss" }).click();

      let keyRow = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(keyRow).toContainText("1 policy binding", { timeout: 120_000 });

      await keyRow.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Rotate key (24h grace)" }).click();
      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: "Dismiss" }).click();
      const rotatedKeyRows = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(rotatedKeyRows).toHaveCount(2);
      await expect(rotatedKeyRows.nth(0)).toContainText("1 policy binding");
      await expect(rotatedKeyRows.nth(1)).toContainText("1 policy binding");
      keyRow = rotatedKeyRows.first();

      await keyRow.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Edit API key" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByLabel("Selected wallets").check();
      await page
        .getByRole("checkbox", { name: /^Select / })
        .first()
        .check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("dialog", { name: "Replace bindings" })).toBeVisible();
      await page.getByRole("button", { name: "Replace bindings" }).click();

      keyRow = page.getByRole("row", { name: new RegExp(keyName) }).first();
      await expect(keyRow).toContainText("1 policy binding", { timeout: 120_000 });
      await keyRow.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Edit API key" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("switch", { name: "Add API-key restrictions" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("dialog", { name: "Clear bindings" })).toBeVisible();
      await page.getByRole("button", { name: "Clear bindings" }).click();

      keyRow = page.getByRole("row", { name: new RegExp(keyName) }).first();
      await expect(keyRow).toContainText("No API-key policy", { timeout: 120_000 });
    });
  });
