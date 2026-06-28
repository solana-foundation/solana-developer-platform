import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type {
  CreatePaymentRecurringPaymentRequest,
  PaymentRecurringPaymentResponse,
} from "@sdp/types";
import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  createExternalSolanaAddress,
  ensureLinkedOrg,
  resolvePlaywrightProjectId,
  seedCounterpartyWithSolanaAccount,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";
import {
  bootstrapLocalPaymentFixtures,
  getBootstrapApiBaseUrl,
} from "../support/local-issuance-bootstrap";

const recurringPaymentsEnabled = process.env.NEXT_PUBLIC_PAYMENTS_RECURRING_ENABLED === "true";

test.describe
  .serial("dashboard recurring payments feature flag", () => {
    let bootstrapProjectId = "";
    let recurringPaymentId = "";
    let recurringCounterpartyName = "";
    let recurringWalletLabel = "";

    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureLinkedOrg(session.identity, { tier: "enterprise" });
      if (recurringPaymentsEnabled) {
        const walletBootstrap = await bootstrapLocalWalletFixtures({
          identity: session.identity,
          bearerToken: session.getBearerToken,
          walletCount: 1,
          tier: "enterprise",
          fundSourceWallet: false,
          walletLabel: "E2E Recurring Treasury",
        });
        const sourceWallet = walletBootstrap.wallets[0];
        if (!sourceWallet) {
          throw new Error("Recurring payment E2E setup did not create a source wallet");
        }
        const projectId = await resolvePlaywrightProjectId(
          getBootstrapApiBaseUrl(),
          session.getBearerToken
        );
        const api = createLocalApiClient(
          getBootstrapApiBaseUrl(),
          session.getBearerToken,
          projectId
        );
        const suffix = randomUUID().slice(0, 8);
        const seededCounterparty = await seedCounterpartyWithSolanaAccount(api, {
          displayName: `E2E Recurring ${suffix}`,
          email: `e2e-recurring-${suffix}@example.com`,
          accountLabel: `E2E Subscription ${suffix}`,
          destinationAddress: sourceWallet.publicKey,
        });

        const input = {
          sourceWalletId: sourceWallet.walletId,
          counterpartyId: seededCounterparty.counterpartyId,
          counterpartyAccountId: seededCounterparty.accountId,
          token: WELL_KNOWN_TOKENS.USDC.mints.devnet,
          amount: "7.5",
          periodHours: 24,
          firstCollectionAt: new Date(Date.now() + 3_600_000).toISOString(),
          metadataUri: "https://example.com/metadata/e2e-recurring-payment.json",
        } satisfies CreatePaymentRecurringPaymentRequest;
        const response = await api.post<PaymentRecurringPaymentResponse>(
          "/v1/payments/recurring-payments",
          input
        );

        bootstrapProjectId = projectId;
        recurringPaymentId = response.recurringPayment.id;
        recurringCounterpartyName = seededCounterparty.displayName;
        recurringWalletLabel = sourceWallet.label ?? sourceWallet.publicKey;
      } else {
        bootstrapProjectId = await resolvePlaywrightProjectId(
          getBootstrapApiBaseUrl(),
          session.getBearerToken
        );
      }
      await session.page.close();
    });

    test.beforeEach(async ({ page }) => {
      await seedProjectCookie(page, bootstrapProjectId);
    });

    test("hides recurring payments when the dashboard feature flag is disabled", async ({
      page,
    }) => {
      test.skip(recurringPaymentsEnabled, "Covered by the feature-enabled recurring payment test");

      await page.goto("/dashboard/payments");

      await expect(page.getByRole("link", { name: "Recurring" })).toHaveCount(0);

      await page.goto("/dashboard/payments/recurring");
      await expect(
        page.getByRole("heading", { name: "Recurring payments unavailable" })
      ).toBeVisible();
      await expect(page.getByText("No recurring payments yet.")).toHaveCount(0);

      await page.goto("/dashboard/payments/recurring/prp_disabled_flag_test");
      await expect(
        page.getByRole("heading", { name: "Recurring payments unavailable" })
      ).toBeVisible();
    });

    test("shows recurring payments when the dashboard feature flag is enabled", async ({
      page,
    }) => {
      test.skip(!recurringPaymentsEnabled, "Requires NEXT_PUBLIC_PAYMENTS_RECURRING_ENABLED=true");

      await page.goto("/dashboard/payments");

      await expect(page.getByRole("link", { name: "Recurring" })).toBeVisible();
      await page.getByRole("link", { name: "Recurring" }).click();
      await expect(page).toHaveURL(/\/dashboard\/payments\/recurring$/);
      await expect(
        page.locator("main").getByRole("heading", { name: "Recurring payments" }).first()
      ).toBeVisible();
      await expect(
        page.getByText("No recurring payments yet.").or(page.locator("tbody tr").first())
      ).toBeVisible({ timeout: 120_000 });

      await expect(page.getByText(recurringCounterpartyName)).toBeVisible();
      await expect(page.getByText(recurringWalletLabel)).toBeVisible();
      await expect(page.getByText("7.50 USDC")).toBeVisible();

      await page.locator("tbody tr").filter({ hasText: recurringCounterpartyName }).first().click();
      await expect(page).toHaveURL(
        new RegExp(`/dashboard/payments/recurring/${recurringPaymentId}$`)
      );
      await expect(
        page.locator("main").getByRole("heading", { level: 1, name: "Recurring payment" })
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to recurring payments" })).toBeVisible();
      await expect(page.getByText("Payment reference")).toBeVisible();
      await expect(page.getByText("Billing setup")).toBeVisible();
      await expect(page.getByText("Plan reference")).toBeVisible();
      await expect(page.getByText("Authorization transaction")).toBeVisible();
      await expect(page.locator("main").getByText("Token mint", { exact: true })).toHaveCount(0);
      await expect(page.locator("main").getByText("Plan PDA", { exact: true })).toHaveCount(0);
      await expect(page.locator("main").getByText("Subscription PDA", { exact: true })).toHaveCount(
        0
      );
    });
  });

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

      sourceWalletLabel = fixtures.wallets.treasury.label ?? fixtures.wallets.treasury.publicKey;
      sourceWalletId = fixtures.wallets.treasury.walletId;
      transferTokenSymbol = fixtures.token.symbol;
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
      const doneButton = app.getByRole("button", { name: "Done", exact: true });
      await doneButton.focus();
      await doneButton.press("Enter");
      await expect(page).toHaveURL(/\/dashboard\/payments(?:\?.*)?$/);

      const transferRow = app.locator("tbody tr").filter({ hasText: destinationAddress }).first();
      await expect(transferRow).toBeVisible({ timeout: 120_000 });
      await expect(transferRow).toContainText("1.00");
    });
  });
