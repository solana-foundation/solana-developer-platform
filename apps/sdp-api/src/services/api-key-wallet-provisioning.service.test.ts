import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { getOrCreateDvpSettlementWallet } from "@/services/dvp/settlement-wallet";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { provisionApiKeyWallet } from "./api-key-wallet-provisioning.service";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");
const ORGANIZATION_ID = "org_api_key_provisioning";
const PROJECT_ID = "prj_api_key_provisioning";
const CONNECTION_ID = "cconn_api_key_provisioning";
const FOREIGN_PROJECT_ID = "prj_api_key_provisioning_foreign";
const CONFIG_ID = "cust_cfg_api_key_provisioning";
const API_KEY = { id: "key_api_key_provisioning", raw: "sk_test_api_key_provisioning" };
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
const auditContext = new Context<{ Bindings: Env }>(new Request("http://localhost/wallets"), {
  env,
});
auditContext.set("apiKey", CACHED_API_KEY);

const originalEnv = {
  byok: env.PRIVY_BYOK_ENABLED,
  appId: env.PRIVY_APP_ID,
  appSecret: env.PRIVY_APP_SECRET,
};

describe("provisionApiKeyWallet", () => {
  beforeEach(async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = "api-key-provisioning-app";
    env.PRIVY_APP_SECRET = "api-key-provisioning-secret";
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.PRIVY_BYOK_ENABLED = originalEnv.byok;
    env.PRIVY_APP_ID = originalEnv.appId;
    env.PRIVY_APP_SECRET = originalEnv.appSecret;
    vi.clearAllMocks();
    await clearKVStores(env);
  });

  it.each([undefined, CONNECTION_ID])(
    "uses the effective or exact Connection without changing defaults (%s)",
    async (connectionId) => {
      if (connectionId) {
        await getDb(env)
          .prepare(
            `UPDATE custody_scope_defaults
             SET default_custody_connection_id = NULL
             WHERE organization_id = ? AND project_id = ?`
          )
          .bind(ORGANIZATION_ID, PROJECT_ID)
          .run();
      }
      provisionPrivyWalletMock.mockResolvedValueOnce({
        walletId: connectionId ? "exact_api_key_wallet" : "effective_api_key_wallet",
        address: "Vote111111111111111111111111111111111111111",
      });

      const wallet = await provisionApiKeyWallet(getDb(env), env, {
        auditContext,
        creationReason: "api_key",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        connectionId,
        label: "API key wallet",
        purpose: "transfer",
      });

      expect(wallet.walletId).toBe(
        connectionId ? "privy_exact_api_key_wallet" : "privy_effective_api_key_wallet"
      );
      expect(
        await getDb(env)
          .prepare(
            `SELECT custody_connection_id, custody_config_id FROM custody_wallets WHERE id = ?`
          )
          .bind(wallet.id)
          .first()
      ).toEqual({ custody_connection_id: CONNECTION_ID, custody_config_id: null });
      expect(
        await getDb(env)
          .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
          .bind(CONNECTION_ID)
          .first()
      ).toEqual({ default_custody_wallet_id: "cwlt_api_key_provisioning_default" });
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
        default_custody_connection_id: connectionId ? null : CONNECTION_ID,
      });
    }
  );

  it("audits first-use DVP wallet creation with its initiating actor, and does not create on reuse", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "dvp_settlement",
      address: "Vote111111111111111111111111111111111111111",
    });
    const scope = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
    const first = await getOrCreateDvpSettlementWallet(env, auditContext, scope);
    expect(await getOrCreateDvpSettlementWallet(env, auditContext, scope)).toEqual(first);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    const audits = await getDb(env).queryMany<{
      api_key_id: string;
      resource_id: string;
      metadata: string;
    }>(
      "SELECT api_key_id, resource_id, metadata FROM audit_logs WHERE resource_type = 'custody_wallet' AND action = 'create'"
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ api_key_id: API_KEY.id, resource_id: first.custodyWalletId });
    const metadata = z
      .object({
        result: z.string(),
        creationReason: z.string(),
        connectionId: z.string(),
      })
      .passthrough()
      .parse(JSON.parse(audits[0].metadata));
    expect(metadata).toMatchObject({
      result: "created",
      creationReason: "dvp_settlement_authority",
      connectionId: CONNECTION_ID,
    });
    expect(metadata).not.toHaveProperty("assignedSettlementAuthority");
  });
});

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  const fingerprint = await getPrivyProviderAccountFingerprint(env.PRIVY_APP_ID as string);
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "API key provisioning",
        "api-key-provisioning",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind("usr_api_key_provisioning", "api-key-provisioning@example.com"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: "usr_api_key_provisioning",
    members: [],
    ids: { sandbox: PROJECT_ID, production: FOREIGN_PROJECT_ID },
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status)
         VALUES (?, ?, ?, 'usr_api_key_provisioning', 'Admin', 'sk_test_api', ?,
                 'api_admin', '["*"]', 'active')`
      )
      .bind(API_KEY.id, ORGANIZATION_ID, PROJECT_ID, keyHash),
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'para', 'test', 'active')`
      )
      .bind(CONFIG_ID, ORGANIZATION_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO provider_credentials
           (id, organization_id, project_id, provider, label, scope, source,
            storage_backend, status, created_by)
         VALUES ('pcred_api_key_provisioning', ?, ?, 'privy', 'Privy', 'project', 'runtime',
                 'runtime_env', 'active', ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, "usr_api_key_provisioning"),
    db
      .prepare(
        `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key, status, created_by)
         VALUES (?, ?, ?, 'privy', 'project', 'pcred_api_key_provisioning', ?, 'pending', ?)`
      )
      .bind(CONNECTION_ID, ORGANIZATION_ID, PROJECT_ID, PROJECT_ID, "usr_api_key_provisioning"),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, label, status)
         VALUES ('cwlt_api_key_provisioning_default', ?, 'privy_api_key_default',
                 '11111111111111111111111111111111', 'Default', 'active')`
      )
      .bind(CONNECTION_ID),
    db
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, status = 'active', last_check_status = 'success',
             last_check_at = sdp_iso_now(), provider_account_fingerprint = ?,
             activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind("cwlt_api_key_provisioning_default", fingerprint, CONNECTION_ID),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id, default_custody_connection_id)
         VALUES ('csd_api_key_provisioning', ?, ?, ?, ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, CONFIG_ID, CONNECTION_ID),
  ]);
}
