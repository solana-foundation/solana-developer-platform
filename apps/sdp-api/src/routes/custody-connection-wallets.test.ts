import { SigningError } from "@sdp/custody/signing";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { getLogger } from "@/runtime/logger";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");

const ORGANIZATION_ID = "org_custody_connection_wallets";
const PROJECT_ID = "prj_custody_connection_wallets";
const USER_ID = "usr_custody_connection_wallets";
const CONFIG_ID = "cust_cfg_connection_wallets";
const CREDENTIAL_ID = "pcred_connection_wallets";
const CONNECTION_ID = "cconn_connection_wallets";
const DEFAULT_WALLET_RECORD_ID = "cwlt_connection_wallets_default";
const DEFAULT_WALLET_ID = "privy_connection_wallets_default";
const SECOND_WALLET_RECORD_ID = "cwlt_connection_wallets_second";
const SECOND_WALLET_ID = "privy_connection_wallets_second";
const API_KEY = {
  id: "key_custody_connection_wallets",
  raw: "sk_test_custody_connection_wallets",
  prefix: "sk_test_ccw",
};
const CACHED_API_KEY: CachedApiKey = {
  id: API_KEY.id,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const originalEnv = {
  byok: env.PRIVY_BYOK_ENABLED,
  appId: env.PRIVY_APP_ID,
  appSecret: env.PRIVY_APP_SECRET,
};

async function seedFixture(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  const fingerprint = await getPrivyProviderAccountFingerprint(env.PRIVY_APP_ID as string);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
      )
      .bind(ORGANIZATION_ID, "Connection wallets", "connection-wallets"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "connection-wallets@example.com"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (
           id, organization_id, name, slug, environment, status, created_by
         ) VALUES (?, ?, 'Connection wallets', 'connection-wallets', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys (
           id, organization_id, project_id, created_by, name, key_prefix,
           key_hash, role, permissions, status
         ) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(API_KEY.id, ORGANIZATION_ID, PROJECT_ID, USER_ID, API_KEY.prefix, keyHash),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted,
           encryption_version, status
         ) VALUES (?, ?, ?, 'para', 'test', 'test', 'active')`
      )
      .bind(CONFIG_ID, ORGANIZATION_ID, PROJECT_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_config_id
         ) VALUES ('csd_connection_wallets', ?, ?, ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, CONFIG_ID),
    getDb(env)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'Runtime Privy', 'project', 'runtime',
                   'runtime_env', 'active', ?)`
      )
      .bind(CREDENTIAL_ID, ORGANIZATION_ID, PROJECT_ID, USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
      )
      .bind(CONNECTION_ID, ORGANIZATION_ID, PROJECT_ID, CREDENTIAL_ID, PROJECT_ID, USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, label, status
         ) VALUES (?, ?, ?, '11111111111111111111111111111111', 'Default', 'active')`
      )
      .bind(DEFAULT_WALLET_RECORD_ID, CONNECTION_ID, DEFAULT_WALLET_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, label, status
         ) VALUES (?, ?, ?, 'So11111111111111111111111111111111111111112', 'Second', 'active')`
      )
      .bind(SECOND_WALLET_RECORD_ID, CONNECTION_ID, SECOND_WALLET_ID),
    getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, status = 'active',
             last_check_status = 'success', last_check_at = sdp_iso_now(),
             provider_account_fingerprint = ?, activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(DEFAULT_WALLET_RECORD_ID, fingerprint, CONNECTION_ID),
  ]);
}

async function request(path: string, method: "POST" | "DELETE", body: unknown): Promise<Response> {
  return app.request(
    `/v1/wallets${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY.raw}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env
  );
}

describe("Connection-owned wallet control plane", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    provisionPrivyWalletMock.mockReset();
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = "connection-wallets-app";
    env.PRIVY_APP_SECRET = "connection-wallets-secret";
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.PRIVY_BYOK_ENABLED = originalEnv.byok;
    env.PRIVY_APP_ID = originalEnv.appId;
    env.PRIVY_APP_SECRET = originalEnv.appSecret;
    await clearKVStores(env);
  });

  it("creates an additional wallet for an exact unselected Connection", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "created_wallet",
      address: "Vote111111111111111111111111111111111111111",
    });

    const response = await request("", "POST", {
      connectionId: CONNECTION_ID,
      provider: "privy",
      label: "Treasury",
      purpose: "transfer",
      setDefault: true,
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: { wallet: Record<string, unknown> & { id: string; walletId: string } };
    };
    expect(body.data.wallet).toMatchObject({
      custodyConnectionId: CONNECTION_ID,
      isRuntimeExecutionAllowed: true,
      walletId: "privy_created_wallet",
      publicKey: "Vote111111111111111111111111111111111111111",
      label: "Treasury",
      purpose: "transfer",
    });
    expect(body.data.wallet).not.toHaveProperty("custodyConfigId");
    expect(body.data.wallet).not.toHaveProperty("provider");
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(provisionPrivyWalletMock).toHaveBeenCalledWith(
      env,
      { credentialRequest: true },
      { appId: "connection-wallets-app", appSecret: "connection-wallets-secret" }
    );

    const persisted = await getDb(env)
      .prepare(
        `SELECT custody_config_id, custody_connection_id, wallet_id
         FROM custody_wallets WHERE id = ?`
      )
      .bind(body.data.wallet.id)
      .first<{
        custody_config_id: string | null;
        custody_connection_id: string | null;
        wallet_id: string;
      }>();
    expect(persisted).toEqual({
      custody_config_id: null,
      custody_connection_id: CONNECTION_ID,
      wallet_id: "privy_created_wallet",
    });
    expect(
      await getDb(env)
        .prepare(
          `SELECT default_custody_config_id, default_custody_connection_id
           FROM custody_scope_defaults WHERE organization_id = ? AND project_id = ?`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .first()
    ).toEqual({
      default_custody_config_id: CONFIG_ID,
      default_custody_connection_id: null,
    });
    expect(
      await getDb(env)
        .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
        .bind(CONNECTION_ID)
        .first()
    ).toEqual({ default_custody_wallet_id: body.data.wallet.id });
  });

  it("fails exact create before Provider access on assertion or runtime errors", async () => {
    const missing = await request("", "POST", { connectionId: "cconn_missing" });
    expect(missing.status).toBe(404);

    const mismatch = await request("", "POST", {
      connectionId: CONNECTION_ID,
      provider: "para",
    });
    expect(mismatch.status).toBe(400);

    env.PRIVY_BYOK_ENABLED = "false";
    const disabled = await request("", "POST", { connectionId: CONNECTION_ID });
    expect(disabled.status).toBe(403);
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });

  it("uses the sole eligible Connection for provider-only creation without selecting it", async () => {
    await getDb(env)
      .prepare("UPDATE custody_configs SET status = 'inactive' WHERE id = ?")
      .bind(CONFIG_ID)
      .run();
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "provider_only",
      address: "Stake11111111111111111111111111111111111111",
    });

    const response = await request("", "POST", { provider: "privy" });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        wallet: {
          custodyConnectionId: CONNECTION_ID,
          walletId: "privy_provider_only",
        },
      },
    });
    expect(
      await getDb(env)
        .prepare("SELECT default_custody_connection_id FROM custody_scope_defaults WHERE id = ?")
        .bind("csd_connection_wallets")
        .first()
    ).toEqual({ default_custody_connection_id: null });
  });

  it("maps an ambiguous Provider result to 503 without a local row", async () => {
    const orphanRiskLog = vi.spyOn(getLogger(), "error").mockImplementation(() => {});
    provisionPrivyWalletMock.mockRejectedValueOnce(new Error("response lost"));
    const before = await walletCount();

    const response = await request("", "POST", { connectionId: CONNECTION_ID });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "PROVIDER_UNAVAILABLE" },
    });
    expect(await walletCount()).toBe(before);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(orphanRiskLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "provider_result_unknown" }),
      "custody_wallet_orphan_risk"
    );
    orphanRiskLog.mockRestore();
  });

  it("does not report a conclusive Provider rejection as orphan risk", async () => {
    const orphanRiskLog = vi.spyOn(getLogger(), "error").mockImplementation(() => {});
    provisionPrivyWalletMock.mockRejectedValueOnce(
      new SigningError("invalid credentials", "PROVIDER_CREDENTIAL_INVALID")
    );

    const response = await request("", "POST", { connectionId: CONNECTION_ID });

    expect(response.status).toBe(503);
    expect(orphanRiskLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "provider_result_unknown" }),
      "custody_wallet_orphan_risk"
    );
    orphanRiskLog.mockRestore();
  });

  it("maps known Provider success plus persistence failure to 500", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: DEFAULT_WALLET_ID,
      address: "11111111111111111111111111111111",
    });
    const before = await walletCount();

    const response = await request("", "POST", { connectionId: CONNECTION_ID });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(await walletCount()).toBe(before);
  });

  it("changes only the owning Connection default wallet", async () => {
    const response = await request("/default-wallet", "POST", {
      walletId: SECOND_WALLET_ID,
      provider: "privy",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { defaultWalletId: SECOND_WALLET_ID },
    });
    expect(
      await getDb(env)
        .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
        .bind(CONNECTION_ID)
        .first()
    ).toEqual({ default_custody_wallet_id: SECOND_WALLET_RECORD_ID });
    expect(
      await getDb(env)
        .prepare("SELECT default_custody_connection_id FROM custody_scope_defaults WHERE id = ?")
        .bind("csd_connection_wallets")
        .first()
    ).toEqual({ default_custody_connection_id: null });

    env.PRIVY_BYOK_ENABLED = "false";
    const disabled = await request("/default-wallet", "POST", {
      walletId: DEFAULT_WALLET_ID,
    });
    expect(disabled.status).toBe(403);
  });

  it("rejects default changes while the owning Connection is unusable", async () => {
    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'retired' WHERE id = ?")
      .bind(CREDENTIAL_ID)
      .run();

    const response = await request("/default-wallet", "POST", {
      walletId: SECOND_WALLET_ID,
    });

    expect(response.status).toBe(409);
    expect(
      await getDb(env)
        .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
        .bind(CONNECTION_ID)
        .first()
    ).toEqual({ default_custody_wallet_id: DEFAULT_WALLET_RECORD_ID });
  });

  it("does not default a Connection wallet deactivated after resolution", async () => {
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());
    const wallet = await targets.findOperationalWallet({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      walletId: SECOND_WALLET_ID,
    });
    expect(wallet).not.toBeNull();
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(SECOND_WALLET_RECORD_ID)
      .run();
    const lookup = vi
      .spyOn(CustodyRuntimeTargets.prototype, "findOperationalWallet")
      .mockResolvedValueOnce(wallet);

    try {
      const response = await request("/default-wallet", "POST", { walletId: SECOND_WALLET_ID });

      expect(response.status).toBe(409);
      expect(
        await getDb(env)
          .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
          .bind(CONNECTION_ID)
          .first()
      ).toEqual({ default_custody_wallet_id: DEFAULT_WALLET_RECORD_ID });
    } finally {
      lookup.mockRestore();
    }
  });

  it("returns static unsupported deletion before Connection runtime gates", async () => {
    env.PRIVY_BYOK_ENABLED = "false";

    const response = await request("", "DELETE", {
      walletId: DEFAULT_WALLET_ID,
      provider: "privy",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Wallet deletion not supported for provider: privy",
      },
    });
    expect(
      await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE id = ?")
        .bind(DEFAULT_WALLET_RECORD_ID)
        .first()
    ).toEqual({ status: "active" });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });
});

async function walletCount(): Promise<number> {
  return (
    (
      await getDb(env)
        .prepare("SELECT COUNT(*) AS count FROM custody_wallets")
        .first<{ count: number }>()
    )?.count ?? 0
  );
}
