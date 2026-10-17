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
      // Grants are explicit (HOO-2099): nothing is granted until a verb is ticked.
      await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
      await page.getByRole("checkbox", { name: "Execute on Transfers" }).check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("radio", { name: /^Selected wallets/ }).check();
      await page
        .getByRole("checkbox", { name: /^Select / })
        .first()
        .check();
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByText("Key identity")).toBeVisible();
      await expect(page.getByText("Transfers: Read, Execute").first()).toBeVisible();

      await page.getByRole("button", { name: "Create key" }).click();

      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await expect(page.locator("#generated-key")).toHaveValue(/^(sk_test_|sk_live_)/);

      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.reload();

      await expect(page.locator("#generated-key")).toHaveCount(0);
      await expect(page.getByText("Your full key (shown once)")).toHaveCount(0);
      const keyRow = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(keyRow).toBeVisible({ timeout: 120_000 });
      await expect(keyRow).toContainText("Transfers: Read, Execute");
      await expect(keyRow).toContainText("1 selected");

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

    test("user can limit a key to reading transfers, keep the grant through rotation, and widen it", async ({
      page,
    }) => {
      const keyName = `Playwright Limited Key ${Date.now()}`;

      await page.goto(projectHref(projectId, "/dashboard/api-keys"));
      await page.getByRole("link", { name: /^(Create new API key|New API key)$/ }).click();
      await page.getByLabel("Name").fill(keyName);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("checkbox", { name: "Read on Transfers" }).check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Create key" }).click();

      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();

      let keyRow = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(keyRow).toContainText("Transfers: Read", { timeout: 120_000 });

      await keyRow.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Rotate key (24h grace)" }).click();
      await expect(page.getByText("API key generated")).toBeVisible({ timeout: 120_000 });
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      const rotatedKeyRows = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(rotatedKeyRows).toHaveCount(2);
      await expect(rotatedKeyRows.nth(0)).toContainText("Transfers: Read");
      await expect(rotatedKeyRows.nth(1)).toContainText("Transfers: Read");
      keyRow = rotatedKeyRows.first();

      // Changing wallet access keeps the grants and needs no confirmation.
      await keyRow.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Edit API key" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("radio", { name: /^Selected wallets/ }).check();
      await page
        .getByRole("checkbox", { name: /^Select / })
        .first()
        .check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Save changes" }).click();

      keyRow = page.getByRole("row", { name: new RegExp(keyName) }).first();
      await expect(keyRow).toContainText("Transfers: Read", { timeout: 120_000 });
      await expect(keyRow).toContainText("1 selected");

      // Widening the grant applies to the same key.
      await keyRow.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Edit API key" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("checkbox", { name: "Execute on Transfers" }).check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Save changes" }).click();

      keyRow = page.getByRole("row", { name: new RegExp(keyName) }).first();
      await expect(keyRow).toContainText("Transfers: Read, Execute", { timeout: 120_000 });
    });
  });
