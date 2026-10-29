/* biome-ignore-all lint/security/noSecrets: Public Solana fixture account; no private keys. */
import { expect, type Page, test } from "@playwright/test";
import { PAYMENT_TRANSFER_STATUSES, type PaymentTransferStatus } from "@sdp/types/payments";
import { Client } from "pg";
import { z } from "zod";
import { paymentsWalletsResponseSchema } from "@/app/dashboard/[projectId]/payments/payments-page.data";
import { projectHref } from "@/lib/dashboard-project-path";
import { getE2EEnv } from "../env";
import {
  createClerkBearerTokenProvider,
  getPlaywrightAdminSession,
  type PlaywrightAdminSession,
} from "../support/auth-session";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  createExternalSolanaAddress,
  getBootstrapApiBaseUrl,
  gotoProjectPage,
  type PlaywrightWalletFixture,
  type SeededCounterparty,
  seedCounterpartyWithSolanaAccount,
  type WalletBootstrapResult,
} from "../support/local-dashboard-bootstrap";

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
const batchResultSchema = z.object({
  batch: z.object({ id: z.string(), sourceCustodyWalletId: z.string() }).loose(),
  transfers: z.array(transferSchema),
});

test.describe
  .serial("Payments exact custody identity through browser and local API", () => {
    let admin: PlaywrightAdminSession;
    let fixture: WalletBootstrapResult;
    let api: LocalApiClient;
    let db: Client;
    let projectId: string;
    let wallet: PlaywrightWalletFixture;
    let alias: PlaywrightWalletFixture;
    let contact: SeededCounterparty;
    let destinationAddress: string;
    const transferIds = new Set<string>();
    const batchIds = new Set<string>();
    const suffix = crypto.randomUUID();
    const aliasRecord = {
      credentialId: `pcred_pr2_${suffix}`,
      connectionId: `cconn_pr2_${suffix}`,
      walletId: `cwlt_pr2_${suffix}`,
    };

    test.beforeAll(async ({ browser }) => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("Payments E2E requires an explicit local DATABASE_URL");
      const database = new URL(databaseUrl);
      const apiUrl = new URL(getBootstrapApiBaseUrl());
      const rpcUrl = new URL(process.env.SOLANA_RPC_URL ?? "");
      if (
        getE2EEnv().useExternalApi ||
        !["http:", "https:"].includes(apiUrl.protocol) ||
        !["postgres:", "postgresql:"].includes(database.protocol) ||
        !["127.0.0.1", "localhost"].includes(apiUrl.hostname) ||
        !["127.0.0.1", "localhost"].includes(database.hostname) ||
        !["http:", "https:"].includes(rpcUrl.protocol) ||
        !["127.0.0.1", "localhost"].includes(rpcUrl.hostname) ||
        process.env.KORA_SURFPOOL_SHIM !== "true"
      ) {
        throw new Error("Payments E2E requires loopback API, Postgres and Surfpool");
      }
      admin = await getPlaywrightAdminSession(browser);
      fixture = await bootstrapLocalWalletFixtures({
        identity: admin.identity,
        bearerToken: admin.getBearerToken,
        provider: "local",
        walletLabel: "Wallet Identity A",
        walletCount: 1,
        fundSourceWallet: true,
        fundSourceAmountSol: 1,
        tier: "enterprise",
      });
      const source = fixture.wallets[0];
      if (!source) throw new Error("Local payment source wallet was not created");
      wallet = source;
      projectId = fixture.projectId;
      api = createLocalApiClient(getBootstrapApiBaseUrl(), admin.getBearerToken, projectId);
      db = new Client({ connectionString: databaseUrl });
      await db.connect();
      await db.query("BEGIN");
      try {
        // A metadata-only Connection shares the source reference; no provider signing is used.
        await db.query(
          `INSERT INTO provider_credentials
            (id, organization_id, project_id, provider, label, scope, source, storage_backend, status)
           VALUES ($1, $2, $3, 'privy', 'Wallet Identity B', 'project', 'runtime', 'runtime_env', 'active')`,
          [aliasRecord.credentialId, fixture.organization.localOrgId, projectId]
        );
        await db.query(
          `INSERT INTO custody_connections
            (id, organization_id, project_id, provider, scope, provider_credential_id,
             provider_credential_scope_key, status)
           VALUES ($1, $2, $3, 'privy', 'project', $4, $3, 'pending')`,
          [
            aliasRecord.connectionId,
            fixture.organization.localOrgId,
            projectId,
            aliasRecord.credentialId,
          ]
        );
        await db.query(
          `INSERT INTO custody_wallets
            (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
           VALUES ($1, $2, $3, $4, 'Wallet Identity B', 'transfer', 'active')`,
          [aliasRecord.walletId, aliasRecord.connectionId, wallet.walletId, wallet.publicKey]
        );
        await db.query(
          `UPDATE custody_connections
           SET default_custody_wallet_id = $2, provider_account_fingerprint = $3,
               status = 'active', last_check_status = 'success', last_check_at = sdp_iso_now(),
               activated_at = sdp_iso_now(), updated_at = sdp_iso_now()
           WHERE id = $1`,
          [aliasRecord.connectionId, aliasRecord.walletId, `sha256:pr2-${suffix}`]
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const listed = paymentsWalletsResponseSchema.shape.data.parse(await api.get("/v1/wallets"));
      const matchedAlias = listed.wallets.find(
        (candidate) => candidate.id === aliasRecord.walletId
      );
      if (!matchedAlias) throw new Error("Project-owned payment alias was not listed");
      alias = matchedAlias;
      expect(matchedAlias.isRuntimeExecutionAllowed).toBe(true);
      expect(alias.walletId).toBe(wallet.walletId);
      expect(alias.publicKey).toBe(wallet.publicKey);
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
          const scope = [fixture.organization.localOrgId, projectId];
          await db.query("BEGIN");
          try {
            await db.query(
              "DELETE FROM payment_transfer_batches WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::text[])",
              [...scope, [...batchIds]]
            );
            await db.query(
              "DELETE FROM payment_transfers WHERE organization_id = $1 AND project_id = $2 AND (id = ANY($3::text[]) OR custody_wallet_id = $4)",
              [...scope, [...transferIds], aliasRecord.walletId]
            );
            await db.query(
              "UPDATE custody_connections SET default_custody_wallet_id = NULL WHERE organization_id = $1 AND project_id = $2 AND id = $3",
              [...scope, aliasRecord.connectionId]
            );
            await db.query(
              `DELETE FROM custody_wallets WHERE id = $1 AND custody_connection_id IN (
                   SELECT id FROM custody_connections WHERE organization_id = $2 AND project_id = $3 AND id = $4
                 )`,
              [aliasRecord.walletId, ...scope, aliasRecord.connectionId]
            );
            await db.query(
              "DELETE FROM custody_connections WHERE organization_id = $1 AND project_id = $2 AND id = $3",
              [...scope, aliasRecord.connectionId]
            );
            await db.query(
              "DELETE FROM provider_credentials WHERE organization_id = $1 AND project_id = $2 AND id = $3",
              [...scope, aliasRecord.credentialId]
            );
            await db.query("COMMIT");
          } catch (error) {
            await db.query("ROLLBACK");
            throw error;
          }
          if (contact) await api.delete(`/v1/counterparties/${contact.counterpartyId}`);
        }
      } finally {
        try {
          await db?.end();
        } finally {
          await admin?.page.close();
        }
      }
    });

    async function selectWallet(page: Page, label: "Source wallet" | "From") {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.getByPlaceholder("Search wallets").fill(wallet.label ?? "Wallet Identity A");
      await page.getByRole("button", { name: wallet.label ?? "Wallet Identity A" }).click();
    }

    test("submits the selected internal wallet with balances and transfer details", async ({
      page,
    }) => {
      await createClerkBearerTokenProvider(page)();
      await gotoProjectPage(page, projectId, "/dashboard/payments/pay");
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
      expect(submitted.transfer).toMatchObject({ custodyWalletId: wallet.id, status: "finalized" });
      expect(submitted.transfer).not.toHaveProperty("providerWalletId");
      await expect(
        page.getByRole("heading", { name: "Transfer submitted", exact: true })
      ).toBeVisible();
      const detail = transferResultSchema.parse(
        await api.get<unknown>(`/v1/payments/transfers/${submitted.transfer.id}`)
      );
      expect(detail.transfer.custodyWalletId).toBe(wallet.id);
      expect(detail.transfer).not.toHaveProperty("providerWalletId");
    });

    test("estimates and submits the exact batch, preserving its recipients and chunk pins", async ({
      page,
    }) => {
      await createClerkBearerTokenProvider(page)();
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

    test("reloads a saved ramp and opens its exact wallet while retaining legacy detail", async ({
      page,
    }) => {
      await createClerkBearerTokenProvider(page)();
      await gotoProjectPage(page, projectId, "/dashboard/payments");
      const quoteResult = await page.evaluate(
        async ({ projectId, body }) => {
          const response = await fetch("/api/dashboard/payments/ramps/offramp/quote", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-project-id": projectId,
              "Idempotency-Key": crypto.randomUUID(),
            },
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
            // Keep the sandbox sale above MoonPay's minimum.
            cryptoAmount: "0.5",
          },
        }
      );
      expect(quoteResult.status).toBe(200);
      const { transferId } = z
        .object({ data: z.object({ transferId: z.string() }) })
        .parse(quoteResult.body).data;
      transferIds.add(transferId);
      const saved = transferResultSchema.parse(
        await api.get<unknown>(`/v1/payments/transfers/${transferId}`)
      );
      expect(saved.transfer).toMatchObject({ custodyWalletId: alias.id, status: "pending" });
      expect(saved.transfer).not.toHaveProperty("providerWalletId");
      await gotoProjectPage(page, projectId, `/dashboard/payments/transactions/${transferId}`);
      await page.reload();
      await expect(page).toHaveURL(
        projectHref(projectId, `/dashboard/payments/transactions/${transferId}`)
      );
      await expect(
        page.getByText(alias.label ?? "Wallet Identity B", { exact: true })
      ).toBeVisible();
      const legacyId = `xfr_pr2_legacy_${crypto.randomUUID()}`;
      const failedId = `xfr_pr2_failed_${crypto.randomUUID()}`;
      const historyRows: Array<[string, string | null, PaymentTransferStatus, string | null]> = [
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
            fixture.organization.localOrgId,
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
      await gotoProjectPage(page, projectId, `/dashboard/payments/transactions/${failedId}`);
      await expect(
        page.getByRole("link", { name: "Open the wallet", exact: true })
      ).toHaveAttribute("href", projectHref(projectId, `/dashboard/wallets/${alias.id}`));
    });
  });
