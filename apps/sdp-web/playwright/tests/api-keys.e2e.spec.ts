import { expect, test } from "@playwright/test";
import { projectHref } from "@/lib/dashboard-project-path";
import {
  bootstrapLocalWalletFixtures,
  provisionWithAdminSession,
} from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard api keys e2e", () => {
    let projectId = "";

    test.beforeAll(async ({ browser }) => {
      const fixtures = await provisionWithAdminSession(browser, (session) =>
        bootstrapLocalWalletFixtures({
          identity: session.identity,
          bearerToken: session.getBearerToken,
          walletCount: 1,
        })
      );
      projectId = fixtures.projectId;
    });

    test("user can create a selected-wallet API key and the secret is only shown once", async ({
      page,
    }) => {
      const keyName = `Playwright Selected Wallet Key ${Date.now()}`;

      await page.goto(projectHref(projectId, "/dashboard/api-keys"));
      await page.getByRole("link", { name: /^(Create new API key|New API key)$/ }).click();

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
      await expect(page.getByText("Allowed operations").first()).toBeVisible();
      await expect(page.getByText("All operations").first()).toBeVisible();

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
      await expect(keyRow).toContainText("All operations");

      const tableBeforeMenu = await page.getByRole("table").boundingBox();
      const bodyOverflowBeforeMenu = await page.evaluate(
        () => window.getComputedStyle(document.body).overflow
      );

      await keyRow.getByRole("button", { name: "Actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Edit API key" })).toBeVisible();

      const tableAfterMenu = await page.getByRole("table").boundingBox();
      expect(tableBeforeMenu).not.toBeNull();
      expect(tableAfterMenu).not.toBeNull();
      expect(tableAfterMenu?.x).toBe(tableBeforeMenu?.x);
      expect(tableAfterMenu?.width).toBe(tableBeforeMenu?.width);
      expect(await page.evaluate(() => window.getComputedStyle(document.body).overflow)).toBe(
        bodyOverflowBeforeMenu
      );
    });

    test("user can limit a key to Issuance, keep the limit through rotation, and clear it", async ({
      page,
    }) => {
      const keyName = `Playwright Limited Key ${Date.now()}`;

      await page.goto(projectHref(projectId, "/dashboard/api-keys"));
      await page.getByRole("link", { name: /^(Create new API key|New API key)$/ }).click();
      await page.getByLabel("Name").fill(keyName);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("radio", { name: /^Only selected operations/ }).check();
      await page.getByRole("checkbox", { name: "Issuance", exact: true }).check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Create key" }).click();

      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: "Dismiss" }).click();

      let keyRow = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(keyRow).toContainText("Issuance", { timeout: 120_000 });

      await keyRow.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Rotate key (24h grace)" }).click();
      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: "Dismiss" }).click();
      const rotatedKeyRows = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(rotatedKeyRows).toHaveCount(2);
      await expect(rotatedKeyRows.nth(0)).toContainText("Issuance");
      await expect(rotatedKeyRows.nth(1)).toContainText("Issuance");
      keyRow = rotatedKeyRows.first();

      // Changing wallet access keeps the limit and needs no confirmation.
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

      keyRow = page.getByRole("row", { name: new RegExp(keyName) }).first();
      await expect(keyRow).toContainText("Issuance", { timeout: 120_000 });
      await expect(keyRow).toContainText("1 selected");

      await keyRow.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Edit API key" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("radio", { name: /^All operations/ }).check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Save changes" }).click();

      keyRow = page.getByRole("row", { name: new RegExp(keyName) }).first();
      await expect(keyRow).toContainText("All operations", { timeout: 120_000 });
    });
  });
