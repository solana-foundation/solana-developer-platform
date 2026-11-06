import { expect, type Page, test } from "@playwright/test";
import { projectHref } from "@/lib/dashboard-project-path";
import {
  bootstrapLocalWalletFixtures,
  provisionWithAdminSession,
} from "../support/local-dashboard-bootstrap";

const SECRET_FORMAT = /^sf_[0-9a-f]{16}_[0-9A-Za-z]{49}$/;

function recordSection(page: Page, title: RegExp) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: title }) })
    .last();
}

function transfersAccessRow(page: Page) {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Transfers", exact: true }) });
}

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
      await page.getByRole("link", { name: "Create key" }).click();

      await page.getByLabel("Name", { exact: true }).fill(keyName);
      await page.getByRole("checkbox", { name: "Execute on Transfers" }).check();
      await expect(page.getByRole("radio", { name: "Selected wallets" })).toBeChecked();
      await page
        .getByRole("checkbox", { name: /^Select / })
        .first()
        .check({ force: true });
      await page.getByRole("button", { name: "Create key" }).click();

      await expect(page).toHaveURL(new RegExp(`/dashboard/${projectId}/api-keys/(?!new$)[^/]+$`), {
        timeout: 120_000,
      });
      const secret = page.locator("[data-api-key-secret]");
      await expect(secret).toHaveText(SECRET_FORMAT);

      await page.getByRole("button", { name: "I have saved this key" }).click();
      await expect(secret).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole("heading", { name: keyName })).toBeVisible({ timeout: 120_000 });
      await expect(secret).toHaveCount(0);

      await page.goto(projectHref(projectId, "/dashboard/api-keys"));
      const keyRow = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(keyRow).toContainText("Can move funds", { timeout: 120_000 });
      await expect(keyRow).toContainText("1 wallet");
    });

    test("user can rotate a key with a grace period, then edit its wallets and access in place", async ({
      page,
    }) => {
      const keyName = `Playwright Limited Key ${Date.now()}`;
      const secret = page.locator("[data-api-key-secret]");

      await page.goto(projectHref(projectId, "/dashboard/api-keys"));
      await page.getByRole("link", { name: "Create key" }).click();
      await page.getByLabel("Name", { exact: true }).fill(keyName);
      await page.getByRole("checkbox", { name: "Read on Transfers" }).check();
      await page.getByRole("button", { name: "Create key" }).click();
      await expect(secret).toHaveText(SECRET_FORMAT, { timeout: 120_000 });
      const firstKeyUrl = page.url();
      const firstSecret = await secret.textContent();
      await page.getByRole("button", { name: "I have saved this key" }).click();

      await page.getByRole("button", { name: "Rotate key…" }).click();
      await page.getByRole("button", { name: "Rotate key", exact: true }).click();
      await expect(page).not.toHaveURL(firstKeyUrl, { timeout: 120_000 });
      await expect(secret).toHaveText(SECRET_FORMAT);
      expect(await secret.textContent()).not.toBe(firstSecret);
      await page.getByRole("button", { name: "I have saved this key" }).click();
      await expect(transfersAccessRow(page)).toContainText("Not held");

      await recordSection(page, /^Wallets/)
        .getByRole("button", { name: "Edit", exact: true })
        .click();
      await page.getByRole("radio", { name: "Selected wallets" }).check({ force: true });
      await page
        .getByRole("checkbox", { name: /^Select / })
        .first()
        .check({ force: true });
      await page.getByRole("button", { name: "Save wallets" }).click();
      await expect(recordSection(page, /^Wallets/)).not.toContainText(
        "All wallets in this project",
        { timeout: 120_000 }
      );

      await recordSection(page, /^Access/)
        .getByRole("button", { name: "Edit", exact: true })
        .click();
      await page.getByRole("checkbox", { name: "Execute on Transfers" }).check();
      await page.getByRole("button", { name: "Save access" }).click();
      await expect(transfersAccessRow(page)).not.toContainText("Not held", { timeout: 120_000 });

      await page.goto(projectHref(projectId, "/dashboard/api-keys"));
      const keyRows = page.getByRole("row", { name: new RegExp(keyName) });
      await expect(keyRows).toHaveCount(2, { timeout: 120_000 });
      await expect(keyRows.filter({ hasText: "Replaced" })).toHaveCount(1);
    });
  });
