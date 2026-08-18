import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient } from "../support/local-api-client";
import {
  ensureLinkedOrg,
  seedCounterpartyWithSolanaAccount,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";
import {
  bootstrapLocalPaymentFixtures,
  getBootstrapApiBaseUrl,
} from "../support/local-issuance-bootstrap";

test.describe
  .serial("dashboard recurring payments", () => {
    let bootstrapProjectId = "";
    let recurringPaymentId = "";
    let recurringCounterpartyName = "";
    let recurringWalletLabel = "";
    let recurringAccountLabel = "";
    let recurringTokenSymbol = "";

    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureLinkedOrg(session.identity, { tier: "enterprise" });
      const fixtures = await bootstrapLocalPaymentFixtures({
        identity: session.identity,
        bearerToken: session.getBearerToken,
        tier: "enterprise",
      });
      const api = createLocalApiClient(
        getBootstrapApiBaseUrl(),
        session.getBearerToken,
        fixtures.projectId
      );

      await api.post(`/v1/issuance/tokens/${fixtures.token.id}/mint`, {
        mint: {
          destination: fixtures.wallets.treasury.publicKey,
          amount: "25",
        },
      });

      const suffix = randomUUID().slice(0, 8);
      recurringAccountLabel = `E2E Subscription ${suffix}`;
      const seededCounterparty = await seedCounterpartyWithSolanaAccount(api, {
        displayName: `E2E Recurring ${suffix}`,
        email: `e2e-recurring-${suffix}@example.com`,
        accountLabel: recurringAccountLabel,
        destinationAddress: fixtures.wallets.treasury.publicKey,
      });

      bootstrapProjectId = fixtures.projectId;
      recurringCounterpartyName = seededCounterparty.displayName;
      recurringWalletLabel = fixtures.wallets.treasury.label ?? fixtures.wallets.treasury.publicKey;
      recurringTokenSymbol = fixtures.token.symbol;
      await session.page.close();
    });

    test.beforeEach(async ({ page }) => {
      await seedProjectCookie(page, bootstrapProjectId);
    });

    test("creates and displays a recurring payment", async ({ page }) => {
      await page.goto("/dashboard/payments");

      await expect(page.getByRole("link", { name: "Recurring", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Recurring", exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard\/payments\/recurring$/);
      await expect(
        page.locator("main").getByRole("heading", { name: "Recurring payments" }).first()
      ).toBeVisible();
      await expect(
        page.getByText("No recurring payments yet.").or(page.locator("tbody tr").first())
      ).toBeVisible({ timeout: 120_000 });

      await page.getByRole("link", { name: "Create recurring payment" }).first().click();
      await expect(page).toHaveURL(/\/dashboard\/payments\/recurring\/create$/);

      const app = page.locator("main");
      const next = app.getByRole("button", { name: "Next", exact: true });

      await app.getByRole("button", { name: "Counterparty", exact: true }).click();
      await page.getByPlaceholder("Search counterparties").fill(recurringCounterpartyName);
      await page.getByRole("button", { name: recurringCounterpartyName }).click();
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      await app.getByRole("button", { name: "Destination account", exact: true }).click();
      await page.getByRole("button", { name: recurringAccountLabel }).click();
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      await app.getByRole("button", { name: "Funding wallet", exact: true }).click();
      await page.getByPlaceholder("Search wallets").fill(recurringWalletLabel);
      await page.getByRole("button", { name: recurringWalletLabel }).click();

      await app.getByRole("button", { name: "Asset", exact: true }).click();
      await expect(page.getByRole("button", { name: /^SOL(?:\s|$)/ })).toHaveCount(0);
      await page
        .getByRole("button", { name: new RegExp(`^${recurringTokenSymbol}( SDP-Minted)?$`) })
        .click();

      await app.getByLabel("Amount", { exact: true }).fill("7.5");
      await app.getByRole("button", { name: "Billing interval", exact: true }).click();
      await page.getByRole("button", { name: "Every day" }).click();
      await expect(next).toBeEnabled({ timeout: 120_000 });
      await next.click();

      await expect(app.getByText("Review recurring payment")).toBeVisible();
      await expect(app.getByText(recurringCounterpartyName)).toBeVisible();
      await expect(app.getByText(recurringWalletLabel)).toBeVisible();
      await expect(app.getByText(`7.5 ${recurringTokenSymbol}`)).toBeVisible();

      const createButton = app.getByRole("button", {
        name: "Create recurring payment",
        exact: true,
      });
      await expect(createButton).toBeEnabled({ timeout: 120_000 });
      await createButton.click();

      await expect(page).toHaveURL(/\/dashboard\/payments\/recurring\/prp_/);
      recurringPaymentId = page.url().split("/").pop() ?? "";
      expect(recurringPaymentId).toMatch(/^prp_/);
      await expect(page.getByText(recurringCounterpartyName).first()).toBeVisible();
      await expect(page.getByText(`7.50 ${recurringTokenSymbol}`, { exact: true })).toBeVisible();
      await expect(page.getByText("Pending activation", { exact: true })).toBeVisible();
      await expect(page.getByText("Every day", { exact: true }).first()).toBeVisible();

      await page.getByRole("link", { name: "Back to recurring payments" }).click();
      await expect(page).toHaveURL(/\/dashboard\/payments\/recurring$/);
      const recurringRow = page
        .getByRole("button")
        .filter({ hasText: recurringCounterpartyName })
        .first();
      await expect(recurringRow).toBeVisible();
      await expect(recurringRow).toContainText(recurringWalletLabel);
      await expect(recurringRow).toContainText(`7.50 ${recurringTokenSymbol}`);

      await recurringRow.getByText(`7.50 ${recurringTokenSymbol}`, { exact: true }).click();
      await expect(page).toHaveURL(
        new RegExp(`/dashboard/payments/recurring/${recurringPaymentId}$`)
      );
      await expect(
        page.locator("main").getByRole("heading", { level: 1, name: "Recurring payment" })
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to recurring payments" })).toBeVisible();
      await expect(page.getByText("Payment reference", { exact: true })).toBeVisible();
      await expect(page.getByText("Billing interval", { exact: true })).toBeVisible();
      await expect(page.getByText("Funding wallet", { exact: true })).toBeVisible();
      await expect(page.getByText("Receiving wallet", { exact: true })).toBeVisible();
      await expect(page.locator("main").getByText("Token mint", { exact: true })).toHaveCount(0);
      await expect(page.locator("main").getByText("Plan PDA", { exact: true })).toHaveCount(0);
      await expect(page.locator("main").getByText("Subscription PDA", { exact: true })).toHaveCount(
        0
      );
    });
  });
