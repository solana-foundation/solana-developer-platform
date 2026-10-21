import { type Page, expect as playwrightExpect, test } from "@playwright/test";
import type {
  CreatedPaymentRequest,
  PaymentRequestLink,
  PaymentsDashboardWallet,
} from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { Client } from "pg";
import { z } from "zod";
import {
  createdPaymentRequestSchema,
  type DashboardPaymentRequest,
} from "@/app/dashboard/[projectId]/payments/requests/payment-requests-page.data";
import { projectHref } from "@/lib/dashboard-project-path";
import { getE2EEnv } from "../env";
import { getPlaywrightAdminSession, type PlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  getBootstrapApiBaseUrl,
  gotoProjectPage,
  resolvePlaywrightProjects,
} from "../support/local-dashboard-bootstrap";

const expect = playwrightExpect.configure({ timeout: 120_000 });
const REQUESTS_PATH = "/dashboard/payments/requests";
type LabeledWallet = PaymentsDashboardWallet & { label: string };

function isolatedDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("Request identity E2E requires an explicit DATABASE_URL");
  const database = new URL(value);
  const api = new URL(getBootstrapApiBaseUrl());
  if (
    getE2EEnv().useExternalApi ||
    !["http:", "https:"].includes(api.protocol) ||
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["localhost", "127.0.0.1"].includes(api.hostname) ||
    !["localhost", "127.0.0.1"].includes(database.hostname)
  )
    throw new Error("Request identity E2E requires loopback API and Postgres");
  return value;
}

test.describe
  .serial("Payment Request exact recipient journeys", () => {
    let admin: PlaywrightAdminSession;
    let api: LocalApiClient;
    let projectId: string;
    let otherProjectId: string;
    let wallets: LabeledWallet[];
    let organizationId: string | undefined;
    let aliasWalletId: string | undefined;
    let connectionId: string | undefined;
    let credentialId: string | undefined;
    const requests: CreatedPaymentRequest[] = [];

    async function database<T>(run: (db: Client) => Promise<T>): Promise<T> {
      const db = new Client({ connectionString: isolatedDatabaseUrl() });
      await db.connect();
      try {
        return await run(db);
      } finally {
        await db.end();
      }
    }

    test.beforeAll(async ({ browser }) => {
      isolatedDatabaseUrl();
      admin = await getPlaywrightAdminSession(browser);
      const fixture = await bootstrapLocalWalletFixtures({
        identity: admin.identity,
        bearerToken: admin.getBearerToken,
        provider: "local",
        walletLabel: "Request Recipient A",
        walletCount: 1,
        fundSourceWallet: false,
        tier: "enterprise",
      });
      organizationId = fixture.organization.localOrgId;
      projectId = fixture.projectId;
      otherProjectId = (
        await resolvePlaywrightProjects(getBootstrapApiBaseUrl(), admin.getBearerToken)
      ).production;
      api = createLocalApiClient(getBootstrapApiBaseUrl(), admin.getBearerToken, projectId);
      const first = fixture.wallets[0];
      if (!first) throw new Error("Missing local recipient fixture");
      const suffix = crypto.randomUUID();
      const secondId = `cwlt_request_identity_${suffix}`;
      aliasWalletId = secondId;
      connectionId = `cconn_request_identity_${suffix}`;
      credentialId = `pcred_request_identity_${suffix}`;
      await database(async (db) => {
        await db.query("BEGIN");
        try {
          // Metadata-only BYOK alias: Request creation receives externally and never decrypts or signs.
          await db.query(
            `INSERT INTO provider_credentials
          (id, organization_id, project_id, provider, label, scope, source, storage_backend, status)
          VALUES ($1, $2, $3, 'privy', 'Request Recipient B', 'project', 'runtime', 'runtime_env', 'active')`,
            [credentialId, fixture.organization.localOrgId, projectId]
          );
          await db.query(
            `INSERT INTO custody_connections
          (id, organization_id, project_id, provider, scope, provider_credential_id, provider_credential_scope_key, status)
          VALUES ($1, $2, $3, 'privy', 'project', $4, $3, 'pending')`,
            [connectionId, fixture.organization.localOrgId, projectId, credentialId]
          );
          await db.query(
            `INSERT INTO custody_wallets
          (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
          VALUES ($1, $2, $3, $4, 'Request Recipient B', 'transfer', 'active')`,
            [secondId, connectionId, first.walletId, first.publicKey]
          );
          await db.query(
            `UPDATE custody_connections SET default_custody_wallet_id = $2,
          provider_account_fingerprint = $3, status = 'active', last_check_status = 'success',
          last_check_at = sdp_iso_now(), activated_at = sdp_iso_now() WHERE id = $1`,
            [connectionId, secondId, `sha256:request-identity-${suffix}`]
          );
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
      });
      const inventory = await api.get<{ wallets: PaymentsDashboardWallet[] }>("/v1/wallets");
      wallets = [first, inventory.wallets.find(({ id }) => id === secondId)]
        .filter((wallet): wallet is PaymentsDashboardWallet => wallet !== undefined)
        .map((wallet) => ({ ...wallet, label: z.string().min(1).regex(/\S/).parse(wallet.label) }));
      expect(wallets).toHaveLength(2);
      expect(wallets[1].walletId).toBe(wallets[0].walletId);
      expect(wallets[1].publicKey).toBe(wallets[0].publicKey);
    });

    test.afterAll(async () => {
      try {
        if (!organizationId) return;
        await database(async (db) => {
          await db.query("BEGIN");
          try {
            await db.query(
              `DELETE FROM payment_requests
               WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::text[])`,
              [organizationId, projectId, requests.map(({ id }) => id)]
            );
            await db.query(
              `UPDATE custody_connections SET default_custody_wallet_id = NULL
               WHERE id = $1 AND organization_id = $2 AND project_id = $3`,
              [connectionId, organizationId, projectId]
            );
            await db.query(
              `DELETE FROM custody_wallets USING custody_connections
               WHERE custody_wallets.id = $1
                 AND custody_wallets.custody_connection_id = custody_connections.id
                 AND custody_connections.id = $2
                 AND custody_connections.organization_id = $3
                 AND custody_connections.project_id = $4`,
              [aliasWalletId, connectionId, organizationId, projectId]
            );
            await db.query(
              `DELETE FROM custody_connections
               WHERE id = $1 AND organization_id = $2 AND project_id = $3`,
              [connectionId, organizationId, projectId]
            );
            await db.query(
              `DELETE FROM provider_credentials
               WHERE id = $1 AND organization_id = $2 AND project_id = $3`,
              [credentialId, organizationId, projectId]
            );
            await db.query("COMMIT");
          } catch (error) {
            await db.query("ROLLBACK");
            throw error;
          }
        });
      } finally {
        await admin?.page.close();
      }
    });

    async function usesNewRequestDesign(page: Page): Promise<boolean> {
      const newRequest = page
        .locator(`a[href="${projectHref(projectId, `${REQUESTS_PATH}/new`)}"]:visible`)
        .first();
      await expect(
        newRequest.or(page.getByRole("button", { name: "Create", exact: true })).first()
      ).toBeVisible();
      return newRequest.isVisible();
    }

    async function createRequest(page: Page, wallet: LabeledWallet, amount: string) {
      await gotoProjectPage(page, projectId, REQUESTS_PATH);
      await expect(page).toHaveURL(projectHref(projectId, REQUESTS_PATH));
      const redesigned = await usesNewRequestDesign(page);
      if (redesigned) {
        await page
          .locator(`a[href="${projectHref(projectId, `${REQUESTS_PATH}/new`)}"]:visible`)
          .first()
          .click();
        await expect(page).toHaveURL(projectHref(projectId, `${REQUESTS_PATH}/new`));
        await page.getByRole("textbox", { name: "Amount", exact: true }).fill(amount);
        await page.getByRole("button", { name: "Destination wallet", exact: true }).click();
        await page.getByRole("button", { name: new RegExp(`^${wallet.label}`) }).click();
      } else {
        await page.getByRole("button", { name: "Create", exact: true }).click();
        const form = page.getByRole("dialog", { name: "Create payment request", exact: true });
        await form.getByLabel("Amount", { exact: true }).fill(amount);
        await form.getByRole("combobox").nth(0).click();
        await page.getByRole("option", { name: "SOL", exact: true }).click();
        await form.getByRole("combobox").nth(1).click();
        await page.getByRole("option", { name: wallet.label, exact: true }).click();
      }
      const responsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/api/dashboard/payments/requests")
      );
      await page
        .getByRole("button", {
          name: redesigned ? "Create and copy link" : "Create link",
          exact: true,
        })
        .click();
      const response = await responsePromise;
      expect(response.request().postDataJSON()).toMatchObject({ custodyWalletId: wallet.id });
      expect(response.request().postDataJSON()).not.toHaveProperty("walletId");
      expect(response.ok()).toBe(true);
      const raw = await response.json();
      expect(raw.data).not.toHaveProperty("walletId");
      expect(raw.data).not.toHaveProperty("providerWalletId");
      const { data } = z.object({ data: createdPaymentRequestSchema }).parse(raw);
      requests.push(data);
      expect(data).toMatchObject({
        custodyWalletId: wallet.id,
        destinationAddress: wallet.publicKey,
        amount,
      });
      if (redesigned) {
        await expect(page).toHaveURL(projectHref(projectId, `${REQUESTS_PATH}/${data.id}`));
        await expect(page.locator("dd").filter({ hasText: wallet.label })).toBeVisible();
      } else {
        await expect(
          page
            .getByRole("dialog", { name: "Payment request details", exact: true })
            .getByText(wallet.label, { exact: true })
        ).toBeVisible();
      }
      return { data, redesigned };
    }

    test("rejects legacy provider selectors through the dashboard without creating a Request", async ({
      page,
    }) => {
      await gotoProjectPage(page, projectId, REQUESTS_PATH);
      const before = await api.get<{ paymentRequests: DashboardPaymentRequest[]; total: number }>(
        "/v1/payments/requests"
      );
      for (const selector of [
        { walletId: wallets[0].walletId },
        { custodyWalletId: wallets[0].id, walletId: wallets[0].walletId },
      ]) {
        const response = await page.request.post("/api/dashboard/payments/requests", {
          headers: { "x-project-id": projectId },
          data: {
            ...selector,
            token: SOL_MINT,
            amount: "99",
          },
        });
        expect(response.status()).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
      }
      const after = await api.get<{ paymentRequests: DashboardPaymentRequest[]; total: number }>(
        "/v1/payments/requests"
      );
      expect(after).toEqual(before);
      await expect(page).toHaveURL(projectHref(projectId, REQUESTS_PATH));
    });

    test("creates alias-equivalent recipients and retains links, QR terms and exact persisted pins", async ({
      page,
    }) => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      for (const [index, wallet] of wallets.entries()) {
        const { data, redesigned } = await createRequest(page, wallet, String(12 + index));
        await page
          .getByRole("button", { name: redesigned ? "Copy link" : "Copy", exact: true })
          .click();
        const link = await page.evaluate(() => navigator.clipboard.readText());
        expect(link).toBe(`${getE2EEnv().baseURL}/pay/${data.publicToken}`);
        const publicResponse = await page.request.get(
          `${getBootstrapApiBaseUrl()}/pay/${data.publicToken}`
        );
        expect(publicResponse.ok()).toBe(true);
        const publicRequest = await publicResponse.json();
        expect(publicRequest).toMatchObject({ recipient: wallet.publicKey, amount: data.amount });
        await page.goto(link);
        await expect(
          page.getByRole("img", { name: "Solana Pay QR code", exact: true })
        ).toBeVisible();
        await expect(
          page.getByRole("img", { name: "Solana Pay QR code", exact: true }).locator("svg")
        ).toBeVisible();
        // biome-ignore lint/security/noSecrets: Public Solana Pay URI selector, not a credential.
        await expect(page.locator('a[href^="solana:"]')).toHaveAttribute(
          "href",
          publicRequest.solanaPayUrl
        );
        const saved = await database((db) =>
          db.query(
            "SELECT custody_wallet_id, public_token, destination_address FROM payment_requests WHERE id = $1",
            [data.id]
          )
        );
        expect(saved.rows[0]).toEqual({
          custody_wallet_id: wallet.id,
          public_token: data.publicToken,
          destination_address: wallet.publicKey,
        });
        await gotoProjectPage(page, projectId, REQUESTS_PATH);
        await page.reload();
        await expect(
          page
            .getByRole("button")
            .filter({ hasText: `${12 + index}.00` })
            .first()
        ).toBeVisible();
      }
      const playground = page.getByRole("tab", { name: "API Playground", exact: true });
      if (!(await usesNewRequestDesign(page))) await expect(playground).toBeVisible();
      if ((await playground.count()) > 0) {
        await playground.click();
        // Requests stay outside Foundation's published playground catalog.
        await expect(
          page.getByText(
            "None of these operations are in the public API reference yet, so the playground has nothing to run here.",
            { exact: true }
          )
        ).toBeVisible();
        await expect(page.getByRole("combobox", { name: "Select API endpoint" })).toHaveCount(0);
        await expect(page.getByLabel(/^custodyWalletId(?:\s+\*)?$/)).toHaveCount(0);
        await expect(page.getByLabel(/^walletId(?:\s+\*)?$/)).toHaveCount(0);
      }
      await gotoProjectPage(page, otherProjectId, REQUESTS_PATH);
      await expect(page).toHaveURL(projectHref(otherProjectId, REQUESTS_PATH));
      await expect(
        page
          .getByText("No payment requests yet", { exact: true })
          .or(page.getByText("You haven't created a request yet", { exact: true }))
      ).toBeVisible();
    });

    test("reopens saved public links with their original QR and payment terms", async ({
      page,
    }) => {
      for (const request of requests) {
        const link = `${getE2EEnv().baseURL}/pay/${request.publicToken}`;
        const response = await page.request.get(
          `${getBootstrapApiBaseUrl()}/pay/${request.publicToken}`
        );
        expect(response.ok()).toBe(true);
        const original = await response.json();
        expect(original).toMatchObject({
          recipient: request.destinationAddress,
          amount: request.amount,
          token: request.token,
          reference: request.reference,
          status: "awaiting_payment",
        });
        await page.goto(link);
        await page.reload();
        await expect(page).toHaveURL(link);
        await expect(
          page.getByRole("img", { name: "Solana Pay QR code", exact: true }).locator("svg")
        ).toBeVisible();
        // biome-ignore lint/security/noSecrets: Public Solana Pay URI selector, not a credential.
        await expect(page.locator('a[href^="solana:"]')).toHaveAttribute(
          "href",
          original.solanaPayUrl
        );
        expect(
          await (
            await page.request.get(`${getBootstrapApiBaseUrl()}/pay/${request.publicToken}`)
          ).json()
        ).toEqual(original);
      }
    });

    test("keeps retained destination evidence for null and unavailable exact pins", async ({
      page,
    }) => {
      await database(async (db) => {
        await db.query(
          "UPDATE payment_requests SET custody_wallet_id = NULL, status = 'canceled' WHERE id = $1",
          [requests[0].id]
        );
        await db.query("UPDATE payment_requests SET status = 'canceled' WHERE id = $1", [
          requests[1].id,
        ]);
        await db.query("UPDATE custody_wallets SET status = 'inactive' WHERE id = $1", [
          wallets[1].id,
        ]);
      });
      const retained = await api.get<{ paymentRequests: DashboardPaymentRequest[] }>(
        "/v1/payments/requests"
      );
      for (const request of requests) {
        const row = retained.paymentRequests.find(({ id }) => id === request.id);
        expect(row).toMatchObject({
          id: request.id,
          destinationAddress: request.destinationAddress,
          reference: request.reference,
          status: "canceled",
        });
        expect(row).not.toHaveProperty("publicToken");
        expect(
          await api.get<PaymentRequestLink>(`/v1/payments/requests/${request.id}/link`)
        ).toEqual({
          id: request.id,
          publicToken: request.publicToken,
        });
        expect(row).not.toHaveProperty("walletId");
        expect(row).not.toHaveProperty("providerWalletId");
      }
      expect(
        retained.paymentRequests.find(({ id }) => id === requests[0].id)?.custodyWalletId
      ).toBeNull();
      for (const request of requests) {
        await gotoProjectPage(page, projectId, REQUESTS_PATH);
        const redesigned = await usesNewRequestDesign(page);
        const detailPath = redesigned ? `${REQUESTS_PATH}/${request.id}` : REQUESTS_PATH;
        await gotoProjectPage(page, projectId, detailPath);
        await expect(page).toHaveURL(projectHref(projectId, detailPath));
        if (!redesigned) {
          await page
            .getByRole("button")
            .filter({ hasText: `${request.amount}.00` })
            .first()
            .click();
        }
        for (const wallet of wallets)
          await expect(page.getByText(wallet.label, { exact: false })).toHaveCount(0);
        await expect(
          page
            .getByText(request.destinationAddress, { exact: true })
            .or(
              page.getByText(
                `${request.destinationAddress.slice(0, 6)}…${request.destinationAddress.slice(-4)}`,
                { exact: true }
              )
            )
            .first()
        ).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
          )
          .toBe(true);
        await page.setViewportSize({ width: 1280, height: 720 });
      }
    });
  });
