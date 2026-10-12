import { randomUUID } from "node:crypto";
import { type Page, expect as playwrightExpect, test } from "@playwright/test";
import type { PaymentRecurringPayment, PaymentRecurringPaymentResponse } from "@sdp/types";
import { Client } from "pg";
import { projectHref } from "@/lib/dashboard-project-path";
import {
  gotoProjectPage,
  seedCounterpartyWithSolanaAccount,
} from "../support/local-dashboard-bootstrap";
import {
  bootstrapWalletIdentityFixtures,
  cleanupWalletIdentityFixtures,
  walletIdentityDatabaseUrl,
} from "../support/payments-wallet-identity";

const expect = playwrightExpect.configure({ timeout: 120_000 });

// This journey only saves pending instructions; its read-only RPC cannot sign or send.
test.describe
  .serial("Managed recurring exact source identity", () => {
    test.skip(process.env.PLAYWRIGHT_RECURRING_IDENTITY !== "1", "Requires isolated PR4 services");
    let fixture: Awaited<ReturnType<typeof bootstrapWalletIdentityFixtures>>;
    let counterparty: Awaited<ReturnType<typeof seedCounterpartyWithSolanaAccount>>;
    const created: string[] = [];

    async function withDatabase(fn: (db: Client) => Promise<void>) {
      const db = new Client({ connectionString: walletIdentityDatabaseUrl("recurring") });
      await db.connect();
      try {
        await fn(db);
      } finally {
        await db.end();
      }
    }

    test.beforeAll(async ({ browser }) => {
      fixture = await bootstrapWalletIdentityFixtures(browser, "recurring");
      counterparty = await seedCounterpartyWithSolanaAccount(fixture.api, {
        displayName: `Recurring Identity ${randomUUID().slice(0, 8)}`,
        accountLabel: "Unfunded recurring identity destination",
        destinationAddress: fixture.walletA.publicKey,
      });
    });

    test.afterAll(async () => {
      try {
        await withDatabase(async (db) => {
          await db.query(
            "DELETE FROM payment_recurring_payments WHERE id = ANY($1::text[]) AND project_id = $2",
            [created, fixture?.projectId ?? ""]
          );
        });
        await cleanupWalletIdentityFixtures("recurring");
      } finally {
        await fixture?.admin.page.close();
      }
    });

    async function createPendingSchedule(page: Page, wallet: { id: string; label: string | null }) {
      if (!wallet.label) throw new Error("Wallet fixture requires a label");
      await gotoProjectPage(page, fixture.projectId, "/dashboard/payments/recurring/create");
      const app = page.locator("main");
      await app.getByRole("button", { name: "Contact", exact: true }).click();
      await page.getByPlaceholder("Search contacts").fill(counterparty.displayName);
      await page.getByRole("button", { name: counterparty.displayName, exact: true }).click();
      await app.getByRole("button", { name: "Source wallet", exact: true }).click();
      await page.getByPlaceholder("Search wallets").fill(wallet.label);
      await page.getByRole("button", { name: wallet.label }).click();
      await app.getByRole("button", { name: "Token", exact: true }).click();
      await page.getByRole("button", { name: /^USDC(?:\s|$)/ }).click();
      await app.getByLabel("Amount", { exact: true }).fill("1");
      const next = app.getByRole("button", { name: "Continue", exact: true });
      await next.click();
      await next.click();
      const response = page.waitForResponse(
        (result) =>
          result.url().endsWith("/api/dashboard/payments/recurring-payments") &&
          result.request().method() === "POST"
      );
      await app.getByRole("button", { name: "Create the schedule", exact: true }).click();
      const savedResponse = await response;
      expect(savedResponse.request().postDataJSON()).toMatchObject({
        sourceCustodyWalletId: wallet.id,
      });
      expect(savedResponse.ok()).toBe(true);
      const saved: { data: PaymentRecurringPaymentResponse } = await savedResponse.json();
      const recurring = saved.data.recurringPayment;
      created.push(recurring.id);
      expect(recurring.sourceCustodyWalletId).toBe(wallet.id);
      expect(recurring.sourceAddress).toBe(fixture.walletA.publicKey);
      expect(recurring.status).toBe("pending_activation");
      await expect(page).toHaveURL(
        projectHref(fixture.projectId, `/dashboard/payments/recurring/${recurring.id}`)
      );
      await expect(app.getByRole("link", { name: wallet.label, exact: true })).toHaveAttribute(
        "href",
        projectHref(fixture.projectId, `/dashboard/wallets/${wallet.id}`)
      );
      await page.reload();
      await expect(app.getByRole("link", { name: wallet.label, exact: true })).toHaveAttribute(
        "href",
        projectHref(fixture.projectId, `/dashboard/wallets/${wallet.id}`)
      );
      return recurring;
    }

    test("creates distinct alias sources, reloads links, explicitly replaces and displays unresolved history", async ({
      page,
    }) => {
      const first = await createPendingSchedule(page, fixture.walletA);
      const second = await createPendingSchedule(page, fixture.walletB);
      await gotoProjectPage(page, fixture.projectId, "/dashboard/payments/recurring");
      for (const [schedule, wallet] of [
        [first, fixture.walletA],
        [second, fixture.walletB],
      ] as const) {
        const row = page.locator("tbody tr").filter({
          has: page.locator(
            `a[href="${projectHref(fixture.projectId, `/dashboard/payments/recurring/${schedule.id}`)}"]`
          ),
        });
        await expect(row).toContainText(wallet.label ?? "");
      }

      await gotoProjectPage(page, fixture.projectId, `/dashboard/payments/recurring/${first.id}`);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("button", { name: "Funding wallet", exact: true }).click();
      await page.getByRole("button", { name: fixture.walletB.label ?? "" }).click();
      const changedResponse = page.waitForResponse(
        (result) =>
          result.url().endsWith(`/api/dashboard/payments/recurring-payments/${first.id}`) &&
          result.request().method() === "PATCH"
      );
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      const changed = await changedResponse;
      expect(changed.request().postDataJSON()).toEqual({
        sourceCustodyWalletId: fixture.walletB.id,
      });
      expect(changed.ok()).toBe(true);
      const persisted = await fixture.api.get<PaymentRecurringPaymentResponse>(
        `/v1/payments/recurring-payments/${first.id}`
      );
      expect(persisted.recurringPayment).toMatchObject({
        id: first.id,
        sourceCustodyWalletId: fixture.walletB.id,
        sourceAddress: first.sourceAddress,
        amount: first.amount,
        periodHours: first.periodHours,
        status: first.status,
      });
      await page.reload();
      await expect(
        page.getByRole("link", { name: fixture.walletB.label ?? "", exact: true })
      ).toHaveAttribute(
        "href",
        projectHref(fixture.projectId, `/dashboard/wallets/${fixture.walletB.id}`)
      );

      await withDatabase(async (db) => {
        await db.query(
          "UPDATE payment_recurring_payments SET source_custody_wallet_id = NULL WHERE id = $1 AND project_id = $2",
          [first.id, fixture.projectId]
        );
      });
      await page.reload();
      await expect(page.getByText("Source wallet unavailable", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /^Wallet Identity [AB]$/ })).toHaveCount(0);
      const history = await fixture.api.get<{ recurringPayment: PaymentRecurringPayment }>(
        `/v1/payments/recurring-payments/${first.id}`
      );
      expect(history.recurringPayment.sourceCustodyWalletId).toBeNull();
      expect(history.recurringPayment.sourceAddress).toBe(first.sourceAddress);
      const shortened = `${first.sourceAddress.slice(0, 6)}…${first.sourceAddress.slice(-4)}`;
      await expect(page.getByText(shortened, { exact: true }).first()).toBeVisible();
    });
  });
