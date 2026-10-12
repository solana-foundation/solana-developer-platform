import { type Browser, expect } from "@playwright/test";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { Client } from "pg";
import { getE2EEnv } from "../env";
import { getPlaywrightAdminSession } from "./auth-session";
import { createLocalApiClient } from "./local-api-client";
import {
  bootstrapLocalWalletFixtures,
  getBootstrapApiBaseUrl,
  resolvePlaywrightProjects,
} from "./local-dashboard-bootstrap";

/** This fixture mutates only an explicitly configured isolated local database. */
function isolatedDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("Wallet identity E2E requires an explicit isolated DATABASE_URL");
  const database = new URL(databaseUrl);
  const apiUrl = new URL(getBootstrapApiBaseUrl());
  if (
    getE2EEnv().useExternalApi ||
    !["127.0.0.1", "localhost"].includes(apiUrl.hostname) ||
    !["127.0.0.1", "localhost"].includes(database.hostname) ||
    !database.port ||
    database.port === "5432" ||
    database.pathname !== "/sdp_wallet_foundation_e2e"
  ) {
    throw new Error(
      "Wallet identity E2E requires loopback API, dedicated Postgres port and sdp_wallet_foundation_e2e database"
    );
  }

  return databaseUrl;
}

export async function cleanupWalletIdentityFixtures() {
  const db = new Client({ connectionString: isolatedDatabaseUrl() });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "UPDATE custody_connections SET default_custody_wallet_id = NULL WHERE id LIKE 'cconn_identity_%'"
    );
    await db.query("DELETE FROM custody_wallets WHERE id LIKE 'cwlt_identity_%'");
    await db.query("DELETE FROM custody_connections WHERE id LIKE 'cconn_identity_%'");
    await db.query("DELETE FROM provider_credentials WHERE id LIKE 'pcred_identity_%'");
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    await db.end();
  }
}

export async function bootstrapWalletIdentityFixtures(browser: Browser) {
  const databaseUrl = isolatedDatabaseUrl();
  await cleanupWalletIdentityFixtures();
  const admin = await getPlaywrightAdminSession(browser);
  const fixture = await bootstrapLocalWalletFixtures({
    identity: admin.identity,
    bearerToken: admin.getBearerToken,
    provider: "local",
    walletLabel: "Wallet Identity A",
    walletCount: 1,
    fundSourceWallet: false,
    tier: "enterprise",
  });
  const walletA = fixture.wallets[0];
  if (!walletA) throw new Error("Local wallet identity fixture was not created");
  const projectId = fixture.projectId;
  const otherProjectId = (
    await resolvePlaywrightProjects(getBootstrapApiBaseUrl(), admin.getBearerToken)
  ).production;
  const api = createLocalApiClient(getBootstrapApiBaseUrl(), admin.getBearerToken, projectId);
  const otherApi = createLocalApiClient(
    getBootstrapApiBaseUrl(),
    admin.getBearerToken,
    otherProjectId
  );
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const walletIds: string[] = [];
  try {
    await db.query("BEGIN");
    for (const [ownerProject, label] of [
      [projectId, "Wallet Identity B"],
      [otherProjectId, "Wallet Identity Other Project"],
    ]) {
      const suffix = crypto.randomUUID();
      const credentialId = `pcred_identity_${suffix}`;
      const connectionId = `cconn_identity_${suffix}`;
      const walletId = `cwlt_identity_${suffix}`;
      // Metadata-only BYOK fixture: balance reads never decrypt credentials or sign.
      await db.query(
        `INSERT INTO provider_credentials
          (id, organization_id, project_id, provider, label, scope, source, storage_backend, status)
         VALUES ($1, $2, $3, 'privy', $4, 'project', 'runtime', 'runtime_env', 'active')`,
        [credentialId, fixture.organization.localOrgId, ownerProject, label]
      );
      await db.query(
        `INSERT INTO custody_connections
          (id, organization_id, project_id, provider, scope, provider_credential_id,
           provider_credential_scope_key, status)
         VALUES ($1, $2, $3, 'privy', 'project', $4, $3, 'pending')`,
        [connectionId, fixture.organization.localOrgId, ownerProject, credentialId]
      );
      await db.query(
        `INSERT INTO custody_wallets
          (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
         VALUES ($1, $2, $3, $4, $5, 'transfer', 'active')`,
        [walletId, connectionId, walletA.walletId, walletA.publicKey, label]
      );
      await db.query(
        `UPDATE custody_connections
         SET default_custody_wallet_id = $2, provider_account_fingerprint = $3,
             status = 'active', last_check_status = 'success', last_check_at = sdp_iso_now(),
             activated_at = sdp_iso_now(), updated_at = sdp_iso_now()
         WHERE id = $1`,
        [connectionId, walletId, `sha256:wallet-identity-${suffix}`]
      );
      walletIds.push(walletId);
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    await admin.page.close();
    throw error;
  } finally {
    await db.end();
  }
  const [wallets, otherWallets] = await Promise.all([
    api.get<{ wallets: PaymentsDashboardWallet[] }>("/v1/wallets"),
    otherApi.get<{ wallets: PaymentsDashboardWallet[] }>("/v1/wallets"),
  ]);
  const walletB = wallets.wallets.find((wallet) => wallet.id === walletIds[0]);
  const otherWallet = otherWallets.wallets.find((wallet) => wallet.id === walletIds[1]);
  if (!walletB || !otherWallet) throw new Error("Project-owned alias fixtures were not listed");
  expect(walletB.isRuntimeExecutionAllowed).toBe(true);
  expect(otherWallet.isRuntimeExecutionAllowed).toBe(true);
  expect(walletB.walletId).toBe(walletA.walletId);
  expect(walletB.publicKey).toBe(walletA.publicKey);
  return { admin, api, otherApi, projectId, otherProjectId, walletA, walletB, otherWallet };
}
