/* biome-ignore-all lint/security/noSecrets: Public Solana account and wallet-list fixture paths; no private keys. */
import { expect, type Page, test } from "@playwright/test";
import { Client } from "pg";
import { projectHref } from "@/lib/dashboard-project-path";
import { getE2EEnv } from "../env";
import {
  getClerkBearerToken,
  getPlaywrightAdminSession,
  type PlaywrightAdminSession,
} from "../support/auth-session";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  getBootstrapApiBaseUrl,
  gotoProjectPage,
  type PlaywrightWalletFixture,
  type SeededCounterparty,
  seedCounterpartyWithSolanaAccount,
} from "../support/local-dashboard-bootstrap";

const TIMEOUT = 120_000;
const DEPOSIT_ADDRESS = "8mSiNWTeu59yxhp2VPuWURbW4N1zF2oX96oVxdThMNS3";

test.describe
  .serial("Payments exact custody identity through browser and local API", () => {
    // shortcut: Dedicated CI wiring needs isolated RPC/provider fixtures; opt in for release acceptance.
    test.skip(
      process.env.PLAYWRIGHT_PAYMENTS_EXACT_IDENTITY !== "1",
      "Requires isolated PR2 runtime"
    );
    let admin: PlaywrightAdminSession;
    let api: LocalApiClient;
    let db: Client;
    let databaseUrl: string | undefined;
    let projectId: string;
    let wallet: PlaywrightWalletFixture;
    let alias: PlaywrightWalletFixture;
    let contact: SeededCounterparty;

    test.beforeAll(async ({ browser }) => {
      expect(getE2EEnv().useExternalApi).toBe(false);
      expect(getE2EEnv().baseURL).toBe("http://localhost:3122");
      expect(getBootstrapApiBaseUrl()).toBe("http://127.0.0.1:8912");
      expect(process.env.SOLANA_RPC_URL).toBe("http://127.0.0.1:9922");
      const database = new URL(process.env.DATABASE_URL ?? "");
      expect(
        ["localhost", "127.0.0.1"].includes(database.hostname) &&
          database.port === "15452" &&
          database.pathname === "/sdp_payments_pr2_8996"
      ).toBe(true);
      databaseUrl = database.toString();
      await cleanupExactIdentityFixtures(databaseUrl);
      admin = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: admin.identity,
        bearerToken: admin.getBearerToken,
        provider: "local",
        walletCount: 1,
        fundSourceWallet: false,
        walletLabel: "Exact Payments A",
        tier: "enterprise",
      });
      projectId = fixtures.projectId;
      wallet = fixtures.wallets[0];
      api = createLocalApiClient(getBootstrapApiBaseUrl(), admin.getBearerToken, projectId);
      db = new Client({ connectionString: database.toString() });
      await db.connect();
      const aliasId = `cwlt_pr2_alias_${wallet.id}`;
      const suffix = crypto.randomUUID();
      const credentialId = `pcred_pr2_${suffix}`;
      const connectionId = `cconn_pr2_${suffix}`;
      await db.query("BEGIN");
      try {
        await db.query(
          `INSERT INTO provider_credentials
           (id, organization_id, project_id, provider, label, scope, source, storage_backend, status)
           VALUES ($1, $2, $3, 'privy', 'Exact Payments B', 'project', 'runtime', 'runtime_env', 'active')`,
          [credentialId, fixtures.organization.localOrgId, projectId]
        );
        await db.query(
          `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key, status)
           VALUES ($1, $2, $3, 'privy', 'project', $4, $3, 'pending')`,
          [connectionId, fixtures.organization.localOrgId, projectId, credentialId]
        );
        await db.query(
          `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
           VALUES ($1, $2, $3, $4, 'Exact Payments B', 'transfer', 'active')`,
          [aliasId, connectionId, wallet.walletId, wallet.publicKey]
        );
        await db.query(
          `UPDATE custody_connections SET default_custody_wallet_id = $2,
           provider_account_fingerprint = $3, status = 'active', last_check_status = 'success',
           last_check_at = sdp_iso_now(), activated_at = sdp_iso_now(), updated_at = sdp_iso_now()
           WHERE id = $1`,
          [connectionId, aliasId, `sha256:payments-pr2-${suffix}`]
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const listed = await api.get<{
        wallets: Array<PlaywrightWalletFixture & { isRuntimeExecutionAllowed: boolean }>;
      }>("/v1/wallets");
      const found = listed.wallets.find((candidate) => candidate.id === aliasId);
      if (!found) throw new Error("Exact alias fixture is not operational");
      expect(found.isRuntimeExecutionAllowed).toBe(true);
      alias = found;
      expect(alias.walletId).toBe(wallet.walletId);
      expect(alias.publicKey).toBe(wallet.publicKey);
      contact = await seedCounterpartyWithSolanaAccount(api, {
        displayName: "Exact Payments Recipient",
        accountLabel: "Exact Recipient Solana",
        destinationAddress: DEPOSIT_ADDRESS,
      });
    });

    test.afterAll(async () => {
      await db?.end();
      await admin?.page.close();
      if (databaseUrl) await cleanupExactIdentityFixtures(databaseUrl);
    });

    async function cleanupExactIdentityFixtures(connectionString: string) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM payment_transfer_batches WHERE source_custody_wallet_id LIKE 'cwlt_pr2_alias_%'"
        );
        await client.query(
          "DELETE FROM payment_transfers WHERE custody_wallet_id LIKE 'cwlt_pr2_alias_%' OR id LIKE 'xfr_pr2_wrong_%'"
        );
        await client.query(
          `DELETE FROM counterparty_provider_accounts AS account
           USING counterparties AS contact
           WHERE account.counterparty_id = contact.id
             AND account.organization_id = contact.organization_id
             AND account.project_id = contact.project_id
             AND account.provider = 'moneygram'
             AND contact.organization_id LIKE 'org_e2e_dashboard_%'
             AND contact.display_name = 'Exact Payments Recipient'`
        );
        await client.query(
          "UPDATE custody_connections SET default_custody_wallet_id = NULL WHERE id LIKE 'cconn_pr2_%'"
        );
        await client.query("DELETE FROM custody_wallets WHERE id LIKE 'cwlt_pr2_alias_%'");
        await client.query("DELETE FROM custody_connections WHERE id LIKE 'cconn_pr2_%'");
        await client.query("DELETE FROM provider_credentials WHERE id LIKE 'pcred_pr2_%'");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    }

    async function selectWallet(page: Page, label: "Source wallet" | "From") {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.getByPlaceholder("Search wallets").fill(alias.label ?? "Exact Payments B");
      await page.getByRole("button", { name: alias.label ?? "Exact Payments B" }).click();
    }

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
      expect(response.request().postDataJSON()).toMatchObject({ sourceCustodyWalletId: alias.id });
      expect(response.status()).toBe(200);
      const submitted = (await response.json()).data;
      expect(submitted.transfer).toMatchObject({ custodyWalletId: alias.id, status: "confirmed" });
      await expect(
        page.getByRole("heading", { name: "Transfer submitted", exact: true })
      ).toBeVisible();
      const detail = await api.get<{ transfer: { id: string; custodyWalletId: string } }>(
        `/v1/payments/transfers/${submitted.transfer.id}`
      );
      expect(detail.transfer.custodyWalletId).toBe(alias.id);
      const before = await api.get<Array<{ id: string }>>(
        `/v1/payments/transfers?custodyWalletId=${alias.id}`
      );
      await db.query("UPDATE custody_wallets SET status = 'inactive' WHERE id = $1", [alias.id]);
      try {
        await expect(
          api.post("/v1/payments/transfers", {
            sourceCustodyWalletId: alias.id,
            destination: DEPOSIT_ADDRESS,
            token: "SOL",
            amount: "0.01",
          })
        ).rejects.toThrow("(404)");
        const after = await api.get<Array<{ id: string }>>(
          `/v1/payments/transfers?custodyWalletId=${alias.id}`
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
      expect(estimate.request().postDataJSON()).toMatchObject({ sourceCustodyWalletId: alias.id });
      const createResult = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/api/dashboard/payments/transfers/batch")
      );
      await page.getByRole("button", { name: "Send batch", exact: true }).click();
      const created = await createResult;
      expect(created.status()).toBe(200);
      expect(created.request().postDataJSON()).toMatchObject({ sourceCustodyWalletId: alias.id });
      const result = (await created.json()).data;
      expect(result.batch).toMatchObject({ sourceCustodyWalletId: alias.id, status: "processing" });
      expect(result.recipients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ destination: DEPOSIT_ADDRESS, amount: "0.01" }),
        ])
      );
      const saved = await api.get<{
        batch: { sourceCustodyWalletId: string };
        transfers: Array<{ custodyWalletId: string }>;
      }>(`/v1/payments/transfer-batches/${result.batch.id}`);
      expect(saved.batch.sourceCustodyWalletId).toBe(alias.id);
      expect(saved.transfers.length).toBeGreaterThan(0);
      for (const transfer of saved.transfers) expect(transfer.custodyWalletId).toBe(alias.id);
    });

    test("continues an exact MoneyGram quote and saved crypto leg through the browser BFF", async ({
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
            provider: "moneygram",
            counterpartyId: contact.counterpartyId,
            sourceCustodyWalletId: alias.id,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            cryptoAmount: "25",
          },
        }
      );
      expect(quoteResult.status).toBe(200);
      const quote: { quote: { sessionId: string }; transferId: string } = quoteResult.body.data;
      async function event(body: object) {
        return page.evaluate(
          async ({ body, projectId }) => {
            const response = await fetch("/api/dashboard/payments/ramps/events/moneygram", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-project-id": projectId },
              body: JSON.stringify(body),
            });
            return response.status;
          },
          { body, projectId }
        );
      }
      expect(
        await event({
          kind: "transaction_created",
          sessionId: quote.quote.sessionId,
          transactionId: `mg_tx_${quote.transferId.slice(4)}`,
        })
      ).toBe(204);
      expect(await event({ kind: "deposit_address", sessionId: quote.quote.sessionId })).toBe(204);
      const legId = `xfr_${crypto.randomUUID()}`;
      await db.query(
        `INSERT INTO payment_transfers (id, organization_id, project_id, custody_wallet_id, wallet_id,
         source_address, destination_address, token, amount, type, direction, status, signature,
         created_at, updated_at)
       SELECT $1, organization_id, project_id, custody_wallet_id, wallet_id, source_address,
              destination_address, token, amount, 'transfer', 'outbound', 'confirmed',
              'saved-e2e-crypto-leg-signature', sdp_iso_now(), sdp_iso_now()
       FROM payment_transfers WHERE id = $2`,
        [legId, quote.transferId]
      );
      const wrongLegId = `xfr_pr2_wrong_${crypto.randomUUID()}`;
      await db.query(
        `INSERT INTO payment_transfers (id, organization_id, project_id, custody_wallet_id, wallet_id,
         source_address, destination_address, token, amount, type, direction, status, signature,
         created_at, updated_at)
         SELECT $1, organization_id, project_id, $2, wallet_id, source_address,
                destination_address, token, amount, type, direction, status,
                'wrong-e2e-crypto-leg-signature', sdp_iso_now(), sdp_iso_now()
         FROM payment_transfers WHERE id = $3`,
        [wrongLegId, wallet.id, legId]
      );
      expect(
        await event({
          kind: "signed",
          sessionId: quote.quote.sessionId,
          cryptoTransferId: wrongLegId,
        })
      ).toBe(400);
      expect(
        await event({ kind: "signed", sessionId: quote.quote.sessionId, cryptoTransferId: legId })
      ).toBe(204);
      const continued = await api.get<{ transfer: { custodyWalletId: string; status: string } }>(
        `/v1/payments/transfers/${quote.transferId}`
      );
      expect(continued.transfer).toMatchObject({ custodyWalletId: alias.id, status: "settling" });
      const failedId = `xfr_${crypto.randomUUID()}`;
      await db.query(
        `INSERT INTO payment_transfers (id, organization_id, project_id, custody_wallet_id, wallet_id,
           source_address, destination_address, token, amount, type, direction, status, created_at, updated_at)
         SELECT $1, organization_id, project_id, custody_wallet_id, wallet_id, source_address,
                destination_address, token, amount, 'transfer', 'outbound', 'failed', sdp_iso_now(), sdp_iso_now()
         FROM payment_transfers WHERE id = $2`,
        [failedId, legId]
      );
      await gotoProjectPage(
        page,
        projectId,
        `/dashboard/payments/transactions?module=payments&custodyWalletId=${alias.id}`
      );
      const failedRow = page.locator("tbody").getByRole("link").filter({ hasText: "Failed" });
      await expect(failedRow).toContainText(alias.label ?? "Exact Payments B", {
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
      const history = await api.get<Array<{ id: string; custodyWalletId: string | null }>>(
        `/v1/payments/transfers?custodyWalletId=${alias.id}`
      );
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: quote.transferId, custodyWalletId: alias.id }),
          expect.objectContaining({ id: legId, custodyWalletId: alias.id }),
        ])
      );
      const other = await api.get<Array<{ id: string }>>(
        `/v1/payments/transfers?custodyWalletId=${wallet.id}`
      );
      expect(other.map((transfer) => transfer.id)).not.toContain(quote.transferId);
      expect(other.map((transfer) => transfer.id)).not.toContain(legId);
    });
  });
