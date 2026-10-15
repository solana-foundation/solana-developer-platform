/* biome-ignore-all lint/security/noSecrets: Public Solana fixture account; no private keys. */
import { expect, type Page, test } from "@playwright/test";
import { PAYMENT_TRANSFER_STATUSES } from "@sdp/types";
import { Client } from "pg";
import { z } from "zod";
import { projectHref } from "@/lib/dashboard-project-path";
import { getClerkBearerToken } from "../support/auth-session";
import {
  createExternalSolanaAddress,
  getPlaywrightDatabaseUrl,
  gotoProjectPage,
  type SeededCounterparty,
  seedCounterpartyWithSolanaAccount,
} from "../support/local-dashboard-bootstrap";
import { bootstrapWalletIdentityFixtures } from "../support/payments-wallet-identity";

const TIMEOUT = 120_000;
const sourceWalletSelectorSchema = z.object({ sourceCustodyWalletId: z.string() });
// Keep extra wire fields visible to the retired-field absence assertions below.
const transferSchema = z
  .object({
    id: z.string(),
    custodyWalletId: z.string().nullable(),
    status: z.enum(PAYMENT_TRANSFER_STATUSES),
  })
  .loose();
const transferResultSchema = z.object({ transfer: transferSchema });
const transferListSchema = z.array(transferSchema.pick({ id: true, custodyWalletId: true }));
const batchResultSchema = z.object({
  batch: z.object({ id: z.string(), sourceCustodyWalletId: z.string() }).loose(),
  transfers: z.array(transferSchema),
});

test.describe
  .serial("Payments exact custody identity through browser and local API", () => {
    let fixture: Awaited<ReturnType<typeof bootstrapWalletIdentityFixtures>>;
    let api: Awaited<ReturnType<typeof bootstrapWalletIdentityFixtures>>["api"];
    let db: Client;
    let projectId: string;
    let wallet: Awaited<ReturnType<typeof bootstrapWalletIdentityFixtures>>["walletA"];
    let alias: Awaited<ReturnType<typeof bootstrapWalletIdentityFixtures>>["walletB"];
    let contact: SeededCounterparty;
    let destinationAddress: string;
    const transferIds = new Set<string>();
    const batchIds = new Set<string>();

    test.beforeAll(async ({ browser }) => {
      fixture = await bootstrapWalletIdentityFixtures(browser);
      ({ api, projectId, walletA: wallet, walletB: alias } = fixture);
      db = new Client({ connectionString: getPlaywrightDatabaseUrl() });
      await db.connect();
      destinationAddress = await createExternalSolanaAddress();
      contact = await seedCounterpartyWithSolanaAccount(api, {
        displayName: `Exact Payments Recipient ${crypto.randomUUID().slice(0, 8)}`,
        accountLabel: "Exact Recipient Solana",
        destinationAddress,
      });
    });

    test.afterAll(async () => {
      try {
        if (db && fixture) {
          const scope = [fixture.organizationId, projectId];
          await db.query(
            "DELETE FROM payment_transfer_batches WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::text[])",
            [...scope, [...batchIds]]
          );
          await db.query(
            "DELETE FROM payment_transfers WHERE organization_id = $1 AND project_id = $2 AND (id = ANY($3::text[]) OR custody_wallet_id = $4)",
            [...scope, [...transferIds], alias.id]
          );
          if (contact) await api.delete(`/v1/counterparties/${contact.counterpartyId}`);
        }
      } finally {
        await db?.end();
        await fixture?.cleanup();
      }
    });

    async function selectWallet(page: Page, label: "Source wallet" | "From") {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.getByPlaceholder("Search wallets").fill(wallet.label ?? "Wallet Identity A");
      await page.getByRole("button", { name: wallet.label ?? "Wallet Identity A" }).click();
    }

    test("uses internal-only balances and refuses legacy and mixed payment selectors", async ({
      page,
    }) => {
      await getClerkBearerToken(page);
      await gotoProjectPage(page, projectId, "/dashboard/payments");
      await expect(
        page.getByRole("heading", { name: "Available balance", exact: true })
      ).toBeVisible({ timeout: TIMEOUT });
      await expect(page).toHaveURL(projectHref(projectId, "/dashboard/payments"), {
        timeout: TIMEOUT,
      });
      const balance = await page.evaluate(
        async ({ projectId, walletId }) => {
          const response = await fetch(`/api/dashboard/payments/wallets/${walletId}/balances`, {
            headers: { "x-project-id": projectId },
          });
          return { status: response.status, body: await response.json() };
        },
        { projectId, walletId: alias.id }
      );
      expect(balance.status).toBe(200);
      const balanceBody = z
        .object({
          data: z.object({
            walletBalances: z.object({ custodyWalletId: z.string(), address: z.string() }).loose(),
          }),
        })
        .parse(balance.body);
      expect(balanceBody.data.walletBalances).toMatchObject({
        custodyWalletId: alias.id,
        address: alias.publicKey,
      });
      expect(balanceBody.data.walletBalances).not.toHaveProperty("walletId");
      const legacyBalanceStatus = await page.evaluate(
        async ({ projectId, walletId }) => {
          const response = await fetch(`/api/dashboard/payments/wallets/${walletId}/balances`, {
            headers: { "x-project-id": projectId },
          });
          return response.status;
        },
        { projectId, walletId: alias.walletId }
      );
      expect(legacyBalanceStatus).toBe(404);

      const recipients = [
        {
          counterpartyId: contact.counterpartyId,
          counterpartyAccountId: contact.accountId,
          amount: "0.01",
        },
      ];
      const writes = [
        {
          path: "/api/dashboard/payments/transfers",
          selector: "sourceCustodyWalletId",
          legacySelector: "sourceWalletId",
          body: { destination: destinationAddress, token: "SOL", amount: "0.01" },
        },
        ...[
          "/api/dashboard/payments/transfers/batch/estimate",
          "/api/dashboard/payments/transfers/batch",
        ].map((path) => ({
          path,
          selector: "sourceCustodyWalletId",
          legacySelector: "sourceWalletId",
          body: { token: "SOL", recipients },
        })),
        {
          path: "/api/dashboard/payments/ramps/onramp/quote",
          selector: "destinationCustodyWalletId",
          legacySelector: "destinationWalletId",
          body: {
            provider: "moonpay",
            counterpartyId: contact.counterpartyId,
            assetRail: "sol.solana",
            fiatCurrency: "USD",
            fiatAmount: "50",
          },
        },
        {
          path: "/api/dashboard/payments/ramps/offramp/quote",
          selector: "sourceCustodyWalletId",
          legacySelector: "sourceWalletId",
          body: {
            provider: "moonpay",
            counterpartyId: contact.counterpartyId,
            assetRail: "sol.solana",
            fiatCurrency: "USD",
            cryptoAmount: "0.01",
          },
        },
      ];
      for (const write of writes) {
        const statuses = await page.evaluate(
          async ({ projectId, write, custodyWalletId, providerWalletId }) => {
            const bodies = [
              { ...write.body, [write.legacySelector]: providerWalletId },
              {
                ...write.body,
                [write.selector]: custodyWalletId,
                [write.legacySelector]: providerWalletId,
              },
              {
                ...write.body,
                [write.selector]: custodyWalletId,
                providerWalletId,
              },
              { ...write.body, [write.selector]: providerWalletId },
            ];
            const statuses = [];
            for (const body of bodies) {
              const response = await fetch(write.path, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-project-id": projectId },
                body: JSON.stringify(body),
              });
              statuses.push(response.status);
            }
            return statuses;
          },
          { projectId, write, custodyWalletId: alias.id, providerWalletId: alias.walletId }
        );
        expect(statuses, write.path).toEqual([400, 400, 400, 404]);
      }
    });

    test("submits the exact selected wallet and refuses fresh execution after its revocation", async ({
      page,
    }) => {
      await getClerkBearerToken(page);
      await gotoProjectPage(page, projectId, "/dashboard/payments/pay");
      await page.getByRole("button", { name: "Contact", exact: true }).click();
      await page.getByPlaceholder("Search contacts").fill(contact.displayName);
      await page.getByRole("button", { name: contact.displayName }).click();
      await page.getByRole("button", { name: "Destination", exact: true }).click();
      await page.getByRole("button", { name: "Exact Recipient Solana" }).click();
      await selectWallet(page, "Source wallet");
      await page.getByRole("button", { name: "Token", exact: true }).click();
      await page.getByRole("button", { name: /^SOL\b/ }).click();
      await page.getByLabel("Amount", { exact: true }).fill("0.01");
      await page.getByRole("button", { name: "Continue to review", exact: true }).click();
      const result = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/api/dashboard/payments/transfers")
      );
      await page.getByRole("button", { name: "Send transfer", exact: true }).click();
      const response = await result;
      expect(sourceWalletSelectorSchema.parse(response.request().postDataJSON())).toMatchObject({
        sourceCustodyWalletId: wallet.id,
      });
      expect(response.status()).toBe(200);
      const submitted = z.object({ data: transferResultSchema }).parse(await response.json()).data;
      transferIds.add(submitted.transfer.id);
      expect(submitted.transfer).toMatchObject({ custodyWalletId: wallet.id, status: "confirmed" });
      expect(submitted.transfer).not.toHaveProperty("providerWalletId");
      await expect(
        page.getByRole("heading", { name: "Transfer submitted", exact: true })
      ).toBeVisible();
      const detail = transferResultSchema.parse(
        await api.get<unknown>(`/v1/payments/transfers/${submitted.transfer.id}`)
      );
      expect(detail.transfer.custodyWalletId).toBe(wallet.id);
      expect(detail.transfer).not.toHaveProperty("providerWalletId");
      const before = transferListSchema.parse(
        await api.get<unknown>(`/v1/payments/transfers?custodyWalletId=${alias.id}`)
      );
      await db.query("UPDATE custody_wallets SET status = 'inactive' WHERE id = $1", [alias.id]);
      try {
        await expect(
          api.post("/v1/payments/transfers", {
            sourceCustodyWalletId: alias.id,
            destination: destinationAddress,
            token: "SOL",
            amount: "0.01",
          })
        ).rejects.toThrow("(404)");
        const after = transferListSchema.parse(
          await api.get<unknown>(`/v1/payments/transfers?custodyWalletId=${alias.id}`)
        );
        expect(after.map((transfer) => transfer.id)).toEqual(before.map((transfer) => transfer.id));
      } finally {
        await db.query("UPDATE custody_wallets SET status = 'active' WHERE id = $1", [alias.id]);
      }
    });

    test("estimates and submits the exact batch, preserving its recipients and chunk pins", async ({
      page,
    }) => {
      await getClerkBearerToken(page);
      await gotoProjectPage(page, projectId, "/dashboard/payments/pay?tab=batch");
      await selectWallet(page, "From");
      await page.getByRole("button", { name: "Token", exact: true }).click();
      await page.getByRole("button", { name: /^SOL\b/ }).click();
      await page.getByText("Pick from contacts", { exact: true }).click();
      await page.getByRole("button", { name: `Add ${contact.displayName}`, exact: true }).click();
      await page.getByLabel(`Amount for ${contact.displayName}`, { exact: true }).fill("0.01");
      const estimateResult = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/api/dashboard/payments/transfers/batch/estimate")
      );
      await page.getByRole("button", { name: "Review payments", exact: true }).click();
      const estimate = await estimateResult;
      expect(estimate.status()).toBe(200);
      expect(sourceWalletSelectorSchema.parse(estimate.request().postDataJSON())).toMatchObject({
        sourceCustodyWalletId: wallet.id,
      });
      const createResult = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/api/dashboard/payments/transfers/batch")
      );
      await page.getByRole("button", { name: "Send batch", exact: true }).click();
      const created = await createResult;
      expect(created.status()).toBe(200);
      expect(sourceWalletSelectorSchema.parse(created.request().postDataJSON())).toMatchObject({
        sourceCustodyWalletId: wallet.id,
      });
      const result = z
        .object({
          data: batchResultSchema.extend({
            batch: batchResultSchema.shape.batch.extend({ status: z.literal("processing") }),
            recipients: z.array(z.object({ destination: z.string(), amount: z.string() })),
          }),
        })
        .parse(await created.json()).data;
      batchIds.add(result.batch.id);
      for (const transfer of result.transfers) transferIds.add(transfer.id);
      expect(result.batch).toMatchObject({
        sourceCustodyWalletId: wallet.id,
        status: "processing",
      });
      expect(result.batch).not.toHaveProperty("sourceProviderWalletId");
      for (const transfer of result.transfers) {
        expect(transfer).not.toHaveProperty("providerWalletId");
      }
      expect(result.recipients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ destination: destinationAddress, amount: "0.01" }),
        ])
      );
      const saved = batchResultSchema.parse(
        await api.get<unknown>(`/v1/payments/transfer-batches/${result.batch.id}`)
      );
      expect(saved.batch.sourceCustodyWalletId).toBe(wallet.id);
      expect(saved.batch).not.toHaveProperty("sourceProviderWalletId");
      expect(saved.transfers.length).toBeGreaterThan(0);
      for (const transfer of saved.transfers) {
        expect(transfer.custodyWalletId).toBe(wallet.id);
        expect(transfer).not.toHaveProperty("providerWalletId");
      }
    });

    test("continues a saved exact MoonPay quote and preserves legacy and exact history links", async ({
      page,
    }) => {
      await getClerkBearerToken(page);
      await gotoProjectPage(page, projectId, "/dashboard/payments");
      const quoteResult = await page.evaluate(
        async ({ projectId, body }) => {
          const response = await fetch("/api/dashboard/payments/ramps/offramp/quote", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-project-id": projectId },
            body: JSON.stringify(body),
          });
          return { status: response.status, body: await response.json() };
        },
        {
          projectId,
          body: {
            provider: "moonpay",
            counterpartyId: contact.counterpartyId,
            sourceCustodyWalletId: alias.id,
            assetRail: "sol.solana",
            fiatCurrency: "USD",
            cryptoAmount: "0.01",
          },
        }
      );
      expect(quoteResult.status).toBe(200);
      const { quote, transferId } = z
        .object({
          data: z.object({
            transferId: z.string(),
            quote: z.object({
              provider: z.literal("moonpay"),
              id: z.string(),
              deliveryMode: z.literal("hosted"),
              status: z.enum(PAYMENT_TRANSFER_STATUSES),
              hostedUrl: z.url(),
            }),
          }),
        })
        .parse(quoteResult.body).data;
      transferIds.add(transferId);
      expect(quote).toMatchObject({
        provider: "moonpay",
        id: transferId,
        deliveryMode: "hosted",
        status: "pending",
      });
      const hostedUrl = new URL(quote.hostedUrl);
      expect(hostedUrl.hostname).toBe("sell-sandbox.moonpay.com");
      expect(hostedUrl.searchParams.get("externalTransactionId")).toBe(transferId);
      expect(hostedUrl.searchParams.get("refundWalletAddress")).toBe(alias.publicKey);
      expect(hostedUrl.searchParams.get("baseCurrencyAmount")).toBe("0.01");
      expect(hostedUrl.searchParams.has("signature")).toBe(true);
      const saved = transferResultSchema.parse(
        await api.get<unknown>(`/v1/payments/transfers/${transferId}`)
      );
      expect(saved.transfer).toMatchObject({ custodyWalletId: alias.id, status: "pending" });
      expect(saved.transfer).not.toHaveProperty("providerWalletId");
      const {
        rows: [storedQuote],
      } = await db.query(
        "SELECT custody_wallet_id, wallet_id, provider_reference, source_address FROM payment_transfers WHERE id = $1 AND organization_id = $2 AND project_id = $3",
        [transferId, fixture.organizationId, projectId]
      );
      expect(storedQuote).toMatchObject({
        custody_wallet_id: alias.id,
        wallet_id: alias.walletId,
        source_address: alias.publicKey,
      });
      await gotoProjectPage(page, projectId, `/dashboard/payments/transactions/${transferId}`);
      await page.reload();
      await expect(page).toHaveURL(
        projectHref(projectId, `/dashboard/payments/transactions/${transferId}`)
      );
      await expect(
        page.getByText(alias.label ?? "Wallet Identity B", { exact: true })
      ).toBeVisible();
      // Cancellation preserves wallet authorization without requiring an executable wallet.
      await db.query("UPDATE custody_wallets SET status = 'inactive' WHERE id = $1", [alias.id]);
      try {
        const cancelled = await page.evaluate(
          async ({ projectId, transferId }) => {
            const response = await fetch("/api/dashboard/payments/ramps/transfers/cancel", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-project-id": projectId },
              body: JSON.stringify({ transferId }),
            });
            return response.status;
          },
          { projectId, transferId }
        );
        expect(cancelled).toBe(200);
        const continued = transferResultSchema.parse(
          await api.get<unknown>(`/v1/payments/transfers/${transferId}`)
        );
        expect(continued.transfer).toMatchObject({
          custodyWalletId: alias.id,
          status: "canceled",
        });
        const {
          rows: [afterCancellation],
        } = await db.query(
          "SELECT custody_wallet_id, wallet_id, provider_reference, source_address FROM payment_transfers WHERE id = $1 AND organization_id = $2 AND project_id = $3",
          [transferId, fixture.organizationId, projectId]
        );
        expect(afterCancellation).toEqual(storedQuote);
      } finally {
        await db.query("UPDATE custody_wallets SET status = 'active' WHERE id = $1", [alias.id]);
      }
      const legacyId = `xfr_pr2_legacy_${crypto.randomUUID()}`;
      const failedId = `xfr_pr2_failed_${crypto.randomUUID()}`;
      const historyRows: Array<[string, string | null, "finalized" | "failed", string | null]> = [
        [legacyId, null, "finalized", "retained-e2e-legacy-signature"],
        [failedId, alias.id, "failed", null],
      ];
      for (const [id, custodyWalletId, status, signature] of historyRows) {
        transferIds.add(id);
        await db.query(
          `INSERT INTO payment_transfers (id, organization_id, project_id, custody_wallet_id, wallet_id,
             source_address, destination_address, token, amount, type, direction, status, signature,
             created_at, updated_at)
           SELECT $1, organization_id, project_id, $2, wallet_id, source_address,
                  $4, token, amount, 'transfer', 'outbound', $3,
                  $8, sdp_iso_now(), sdp_iso_now()
           FROM payment_transfers WHERE id = $5 AND organization_id = $6 AND project_id = $7`,
          [
            id,
            custodyWalletId,
            status,
            destinationAddress,
            transferId,
            fixture.organizationId,
            projectId,
            signature,
          ]
        );
      }
      const legacyBrowserDetail = await page.evaluate(
        async ({ projectId, transferId }) => {
          const response = await fetch(`/api/dashboard/payments/transfers/${transferId}`, {
            headers: { "x-project-id": projectId },
          });
          return { status: response.status, body: await response.json() };
        },
        { projectId, transferId: legacyId }
      );
      expect(legacyBrowserDetail.status).toBe(200);
      const legacyDetailBody = z
        .object({
          data: transferResultSchema.extend({
            transfer: transferSchema.extend({ signature: z.string() }),
          }),
        })
        .parse(legacyBrowserDetail.body);
      expect(legacyDetailBody.data.transfer).toMatchObject({
        id: legacyId,
        custodyWalletId: null,
        signature: "retained-e2e-legacy-signature",
      });
      expect(legacyDetailBody.data.transfer).not.toHaveProperty("providerWalletId");
      const legacyHistory = transferListSchema.parse(
        await api.get<unknown>("/v1/payments/transfers")
      );
      expect(legacyHistory).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: legacyId, custodyWalletId: null })])
      );
      await gotoProjectPage(
        page,
        projectId,
        `/dashboard/payments/transactions?module=payments&custodyWalletId=${alias.id}`
      );
      const failedRow = page.locator("tbody").getByRole("link").filter({ hasText: "Failed" });
      await expect(failedRow).toContainText(alias.label ?? "Wallet Identity B", {
        timeout: TIMEOUT,
      });
      await failedRow.click();
      await expect(page).toHaveURL(
        projectHref(projectId, `/dashboard/payments/transactions/${failedId}`),
        { timeout: TIMEOUT }
      );
      await expect(
        page.getByRole("link", { name: "Open the wallet", exact: true })
      ).toHaveAttribute("href", projectHref(projectId, `/dashboard/wallets/${alias.id}`));
      const exactHistory = transferListSchema.parse(
        await api.get<unknown>(`/v1/payments/transfers?custodyWalletId=${alias.id}`)
      );
      expect(exactHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: transferId }),
          expect.objectContaining({ id: failedId }),
        ])
      );
      const otherHistory = transferListSchema.parse(
        await api.get<unknown>(`/v1/payments/transfers?custodyWalletId=${wallet.id}`)
      );
      expect(otherHistory.map((transfer) => transfer.id)).not.toContain(transferId);
      expect(otherHistory.map((transfer) => transfer.id)).not.toContain(failedId);
    });
  });
