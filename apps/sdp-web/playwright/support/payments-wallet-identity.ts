import { type Browser, expect } from "@playwright/test";
import { Client } from "pg";
import { paymentsWalletsResponseSchema } from "@/app/dashboard/[projectId]/payments/payments-page.data";
import { getE2EEnv } from "../env";
import { getPlaywrightAdminSession } from "./auth-session";
import { createLocalApiClient } from "./local-api-client";
import {
  bootstrapLocalWalletFixtures,
  getBootstrapApiBaseUrl,
  getPlaywrightDatabaseUrl,
  resolvePlaywrightProjects,
} from "./local-dashboard-bootstrap";

function getLocalDatabaseUrl(): string {
  const databaseUrl = getPlaywrightDatabaseUrl();
  const database = new URL(databaseUrl);
  const apiUrl = new URL(getBootstrapApiBaseUrl());
  if (
    getE2EEnv().useExternalApi ||
    !["http:", "https:"].includes(apiUrl.protocol) ||
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost"].includes(apiUrl.hostname) ||
    !["127.0.0.1", "localhost"].includes(database.hostname)
  ) {
    throw new Error("Wallet identity E2E requires loopback API and Postgres");
  }

  return databaseUrl;
}

async function cleanupWalletIdentityFixtures(
  databaseUrl: string,
  organizationId: string,
  records: Array<{ credentialId: string; connectionId: string; walletId: string }>
) {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const connectionIds = records.map((record) => record.connectionId);
  try {
    await db.query("BEGIN");
    await db.query(
      `UPDATE custody_connections SET default_custody_wallet_id = NULL
       WHERE organization_id = $1 AND id = ANY($2::text[])`,
      [organizationId, connectionIds]
    );
    await db.query(
      `DELETE FROM custody_wallets
       WHERE id = ANY($1::text[]) AND custody_connection_id IN (
         SELECT id FROM custody_connections WHERE organization_id = $2 AND id = ANY($3::text[])
       )`,
      [records.map((record) => record.walletId), organizationId, connectionIds]
    );
    await db.query(
      `DELETE FROM custody_connections WHERE organization_id = $1 AND id = ANY($2::text[])`,
      [organizationId, connectionIds]
    );
    await db.query(
      `DELETE FROM provider_credentials WHERE organization_id = $1 AND id = ANY($2::text[])`,
      [organizationId, records.map((record) => record.credentialId)]
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    await db.end();
  }
}

export async function bootstrapWalletIdentityFixtures(browser: Browser) {
  const databaseUrl = getLocalDatabaseUrl();
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
  const records: Array<{ credentialId: string; connectionId: string; walletId: string }> = [];
  const cleanup = async () => {
    try {
      await cleanupWalletIdentityFixtures(databaseUrl, fixture.organization.localOrgId, records);
    } finally {
      await admin.page.close();
    }
  };
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
      records.push({ credentialId, connectionId, walletId });
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    await cleanup();
    throw error;
  } finally {
    await db.end();
  }
  try {
    const [walletBRecord, otherWalletRecord] = records;
    if (!walletBRecord || !otherWalletRecord) {
      throw new Error("Project-owned alias fixtures were not created");
    }
    const [wallets, otherWallets] = await Promise.all([
      api.get("/v1/wallets"),
      otherApi.get("/v1/wallets"),
    ]);
    const walletB = paymentsWalletsResponseSchema.shape.data
      .parse(wallets)
      .wallets.find((wallet) => wallet.id === walletBRecord.walletId);
    const otherWallet = paymentsWalletsResponseSchema.shape.data
      .parse(otherWallets)
      .wallets.find((wallet) => wallet.id === otherWalletRecord.walletId);
    if (!walletB || !otherWallet) throw new Error("Project-owned alias fixtures were not listed");
    expect(walletB.isRuntimeExecutionAllowed).toBe(true);
    expect(otherWallet.isRuntimeExecutionAllowed).toBe(true);
    expect(walletB.walletId).toBe(walletA.walletId);
    expect(walletB.publicKey).toBe(walletA.publicKey);
    return {
      admin,
      api,
      otherApi,
      projectId,
      otherProjectId,
      walletA,
      walletB,
      otherWallet,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
