import { randomUUID } from "node:crypto";
import { type Page, expect as playwrightExpect, test } from "@playwright/test";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { Client } from "pg";
import { z } from "zod";
import { recurringPaymentEnvelopeSchema } from "@/app/dashboard/[projectId]/payments/recurring/recurring-payments.data";
import { projectHref } from "@/lib/dashboard-project-path";
import { gotoProjectPage } from "../support/local-dashboard-bootstrap";
import {
  bootstrapWalletIdentityFixtures,
  walletIdentityDatabaseUrl,
} from "../support/payments-wallet-identity";

const expect = playwrightExpect.configure({ timeout: 120_000 });
const counterpartySchema = z.object({ id: z.string().min(1), displayName: z.string().min(1) });
const tokenFixtureResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal("recurring-identity-token-fixture"),
  result: z.object({
    context: z.object({ slot: z.number().int().nonnegative() }),
    value: z.null(),
  }),
  error: z.never().optional(),
});

test.describe
  .serial("Managed recurring exact source identity", () => {
    let fixture: Awaited<ReturnType<typeof bootstrapWalletIdentityFixtures>>;
    let counterparty: z.infer<typeof counterpartySchema>;
    let counterpartyId: string | undefined;

    async function withDatabase(fn: (db: Client) => Promise<void>) {
      const db = new Client({ connectionString: walletIdentityDatabaseUrl() });
      await db.connect();
      try {
        await fn(db);
      } finally {
        await db.end();
      }
    }

    test.beforeAll(async ({ browser }) => {
      const rpcUrl = new URL(process.env.SOLANA_RPC_URL ?? "");
      if (
        !["http:", "https:"].includes(rpcUrl.protocol) ||
        !["127.0.0.1", "localhost"].includes(rpcUrl.hostname)
      ) {
        throw new Error("Recurring identity fixtures require local Surfpool RPC");
      }
      fixture = await bootstrapWalletIdentityFixtures(browser, { preserveExistingFixtures: true });
      // The token picker needs a real local token account; no transaction is signed or sent.
      const seeded = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "recurring-identity-token-fixture",
          method: "surfnet_setTokenAccount",
          params: [
            fixture.walletA.publicKey,
            WELL_KNOWN_TOKENS.USDC.mints.devnet.address,
            { amount: 100_000_000 },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      expect(seeded.ok).toBe(true);
      tokenFixtureResponseSchema.parse(await seeded.json());
      const created: unknown = await fixture.api.post("/v1/counterparties", {
        entityType: "individual",
        displayName: `Recurring Identity ${randomUUID().slice(0, 8)}`,
      });
      // Retain the owned ID for cleanup even if another response field is invalid.
      counterpartyId = z
        .object({ counterparty: counterpartySchema.pick({ id: true }) })
        .parse(created).counterparty.id;
      counterparty = z.object({ counterparty: counterpartySchema }).parse(created).counterparty;
      await fixture.api.post(`/v1/counterparties/${counterparty.id}/accounts`, {
        accountKind: "crypto_wallet",
        label: "Unfunded recurring identity destination",
        details: { network: "solana", address: fixture.walletA.publicKey },
      });
    });

    test.afterAll(async () => {
      try {
        if (counterpartyId) {
          await withDatabase(async (db) => {
            await db.query("BEGIN");
            try {
              // Include this run's schedules whose source pin was intentionally cleared.
              await db.query(
                "DELETE FROM payment_recurring_payments WHERE counterparty_id = $1 AND project_id = $2",
                [counterpartyId, fixture.projectId]
              );
              await db.query("DELETE FROM counterparties WHERE id = $1 AND project_id = $2", [
                counterpartyId,
                fixture.projectId,
              ]);
              await db.query("COMMIT");
            } catch (error) {
              await db.query("ROLLBACK");
              throw error;
            }
          });
        }
      } finally {
        await fixture?.cleanup();
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
      await page.route(
        "**/api/dashboard/payments/recurring-payments",
        (route) =>
          route.continue({
            postData: JSON.stringify({
              ...route.request().postDataJSON(),
              sourceProviderWalletId: "retired-provider-selector",
            }),
          }),
        { times: 1 }
      );
      const refusal = page.waitForResponse(
        (result) =>
          result.url().endsWith("/api/dashboard/payments/recurring-payments") &&
          result.request().method() === "POST"
      );
      await app.getByRole("button", { name: "Create the schedule", exact: true }).click();
      expect((await refusal).status()).toBe(400);
      await expect(app.getByRole("alert")).toBeVisible();
      await expect(page).toHaveURL(
        projectHref(fixture.projectId, "/dashboard/payments/recurring/create")
      );
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
      expect(savedResponse.request().postDataJSON()).not.toHaveProperty("sourceProviderWalletId");
      expect(savedResponse.ok()).toBe(true);
      const savedJson: unknown = await savedResponse.json();
      expect(savedJson).not.toHaveProperty("data.recurringPayment.sourceProviderWalletId");
      const saved = recurringPaymentEnvelopeSchema.parse(savedJson);
      const recurring = saved.data.recurringPayment;
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
    }, testInfo) => {
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
      const persistedJson: unknown = await fixture.api.get(
        `/v1/payments/recurring-payments/${first.id}`
      );
      expect(persistedJson).not.toHaveProperty("recurringPayment.sourceProviderWalletId");
      const persisted = recurringPaymentEnvelopeSchema.shape.data.parse(persistedJson);
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
      for (const wallet of [fixture.walletA, fixture.walletB]) {
        await expect(page.getByRole("link", { name: wallet.label ?? "", exact: true })).toHaveCount(
          0
        );
      }
      const historyJson: unknown = await fixture.api.get(
        `/v1/payments/recurring-payments/${first.id}`
      );
      expect(historyJson).not.toHaveProperty("recurringPayment.sourceProviderWalletId");
      const history = recurringPaymentEnvelopeSchema.shape.data.parse(historyJson);
      expect(history.recurringPayment.sourceCustodyWalletId).toBeNull();
      expect(history.recurringPayment.sourceAddress).toBe(first.sourceAddress);
      const shortened = `${first.sourceAddress.slice(0, 6)}…${first.sourceAddress.slice(-4)}`;
      await expect(page.getByText(shortened, { exact: true }).first()).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("recurring-identity-preserved-history.png"),
        fullPage: true,
      });
    });
  });
