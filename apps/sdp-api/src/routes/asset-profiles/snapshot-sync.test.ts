/**
 * Regression tests for APE-848 (SOLA9-632): pending asset-profile advanced
 * settings must be bound to the deployment snapshot.
 *
 * A pending token is deployed from its `issued_tokens` snapshot (template,
 * freeze_authority_enabled, allowlist_enabled, issued_token_extensions). The
 * asset profile's `issuanceMetadata.settings.selected` is the reviewed source
 * of truth for those fields, so a profile PATCH on a pending token must
 * resolve the selection and persist the snapshot atomically — and deployment
 * must refuse to run while the two disagree.
 */

import { MosaicService } from "@sdp/issuance/mosaic/service";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, Permission } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { TokenService } from "@/services/token.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { seedCachedApiKey } from "@/test/mocks/kv";

const ADMIN_KEY = {
  id: "key_snapshot_admin",
  raw: "sk_test_snapshot_admin",
  prefix: "sk_test_snap_a",
};
const DEPLOYER_KEY = {
  id: "key_snapshot_deployer",
  raw: "sk_test_snapshot_deployer",
  prefix: "sk_test_snap_d",
};

const DRIFT_CUSTODY_CONFIG_ID = "cust_cfg_snapshot_drift";
const DRIFT_CUSTODY_WALLET_ID = "cwlt_snapshot_drift";
const DRIFT_PROVIDER_WALLET_ID = "wal_snapshot_drift";

const CREATE_BODY = {
  name: "Snapshot Drift Token",
  symbol: "DRIFT",
  template: "custom",
  decimals: 9,
  isFreezable: false,
  assetCategory: "generic",
  assetType: "generic",
  issuanceMetadata: {
    asset: { name: "Snapshot Drift Token" },
    settings: { selected: {} },
  },
};

function cachedKey(key: typeof ADMIN_KEY, permissions: Permission[]): CachedApiKey {
  return {
    id: key.id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    role: "api_admin",
    permissions,
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
    rotationDeadline: null,
    organizationStatus: "active",
  };
}

function headers(rawKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${rawKey}`,
  };
}

// Shape of the envelopes used below (`success(c, response)` / AppError body).
interface SuccessJson {
  // biome-ignore lint/suspicious/noExplicitAny: free-form success envelope; the assertions own the shape.
  data: Record<string, any>;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

async function createPendingTokenWithProfile(
  overrides: Record<string, unknown> = {},
  rawKey: string = ADMIN_KEY.raw
): Promise<{ tokenId: string; profileId: string; token: Record<string, unknown> }> {
  const response = await app.request(
    "/v1/issuance/asset-profiles",
    {
      method: "POST",
      headers: headers(rawKey),
      body: JSON.stringify({ ...CREATE_BODY, ...overrides }),
    },
    env
  );
  expect(response.status).toBe(201);
  const json = (await response.json()) as SuccessJson;
  return {
    tokenId: json.data.token.id,
    profileId: json.data.assetProfile.id,
    token: json.data.token,
  };
}

async function patchProfile(
  profileId: string,
  rawKey: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: SuccessJson }> {
  const response = await app.request(
    `/v1/issuance/asset-profiles/${profileId}`,
    {
      method: "PATCH",
      headers: headers(rawKey),
      body: JSON.stringify(body),
    },
    env
  );
  return { status: response.status, json: (await response.json()) as SuccessJson };
}

async function getToken(
  tokenId: string,
  rawKey: string = DEPLOYER_KEY.raw
): Promise<Record<string, unknown>> {
  const response = await app.request(
    `/v1/issuance/tokens/${tokenId}`,
    { headers: headers(rawKey) },
    env
  );
  expect(response.status).toBe(200);
  const json = await response.json();
  return json.data.token;
}

async function tokenRow(tokenId: string): Promise<Record<string, unknown> | null> {
  return getDb(env)
    .prepare(
      "SELECT status, template, freeze_authority_enabled, allowlist_enabled, mint_address FROM issued_tokens WHERE id = ?"
    )
    .bind(tokenId)
    .first<Record<string, unknown>>();
}

async function extensionRows(tokenId: string): Promise<string[]> {
  const result = await getDb(env)
    .prepare("SELECT extension FROM issued_token_extensions WHERE token_id = ? ORDER BY extension")
    .bind(tokenId)
    .all<{ extension: string }>();
  return result.results.map((row) => row.extension);
}

async function seedDriftCustodyWallet(): Promise<void> {
  const db = getDb(env);
  // One batch: the config's default-wallet FK is deferrable, so the pair must
  // commit together (mirrors seedIssuanceActivityWallet).
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, 'local', 'test-config', 'sdp-custody-encryption-v1', ?, 'active')`
      )
      .bind(DRIFT_CUSTODY_CONFIG_ID, TEST_ORG.id, TEST_PROJECT.id, DRIFT_PROVIDER_WALLET_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, '9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz', 'Drift Wallet', 'transfer', 'active')`
      )
      .bind(DRIFT_CUSTODY_WALLET_ID, DRIFT_CUSTODY_CONFIG_ID, DRIFT_PROVIDER_WALLET_ID),
  ]);
}

describe("asset profile PATCH binds pending advanced settings to the deployment snapshot", () => {
  let adminHash: string;
  let deployerHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    adminHash = await hashString(ADMIN_KEY.raw, (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER);
    deployerHash = await hashString(
      DEPLOYER_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    // Clear rate limit KV to prevent 429 errors between tests
    const keys = await kv.rateLimits.list();
    for (const key of keys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    await db
      .prepare("DELETE FROM custody_wallets WHERE custody_config_id = ?")
      .bind(DRIFT_CUSTODY_CONFIG_ID)
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM custody_configs WHERE id = ?")
      .bind(DRIFT_CUSTODY_CONFIG_ID)
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM asset_profiles")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issued_token_extensions")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issued_tokens")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM project_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});

    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status, settings)
         VALUES (?, ?, ?, 'individual', 'active', '{"providerOverrides":{"custody":{"local":true}}}')
         ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });

    await seedProjectApiKey(db, env, {
      key: ADMIN_KEY,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      role: "api_admin",
      permissions: ["tokens:admin", "tokens:read", "tokens:write"],
    });
    await seedProjectApiKey(db, env, {
      key: DEPLOYER_KEY,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      role: "api_developer",
      permissions: ["tokens:read", "tokens:write"],
    });

    await seedCachedApiKey(
      env,
      adminHash,
      cachedKey(ADMIN_KEY, ["tokens:admin", "tokens:read", "tokens:write"])
    );
    await seedCachedApiKey(
      env,
      deployerHash,
      cachedKey(DEPLOYER_KEY, ["tokens:read", "tokens:write"])
    );
  });

  it("persists the resolved snapshot when a pending profile's advanced settings change", async () => {
    const { tokenId, profileId, token } = await createPendingTokenWithProfile();
    expect(token.isFreezable).toBe(false);
    expect(token.template).toBe("custom");

    // The reviewed save: enable freezeAccounts via the compliance policy.
    const { status, json } = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { freezeAccounts: {} } },
      },
    });
    expect(status).toBe(200);
    expect(json.data.assetProfile.issuanceMetadata.settings.selected).toEqual({
      freezeAccounts: {},
    });

    // The response carries the updated deployment snapshot so callers see what
    // a deploy would now initialize.
    expect(json.data.token).toBeDefined();
    expect(json.data.token.isFreezable).toBe(true);

    // The deployment snapshot (what deploy consumes and the dashboard reads)
    // must match the reviewed profile.
    const deployedView = await getToken(tokenId);
    expect(deployedView.isFreezable).toBe(true);
    expect(deployedView.template).toBe("custom");

    const row = await tokenRow(tokenId);
    expect(row?.status).toBe("pending");
    expect(row?.freeze_authority_enabled).toBe(1);
  });

  it("keeps tokens:write from changing the compliance policy (negative control)", async () => {
    const { profileId } = await createPendingTokenWithProfile();
    const { status, json } = await patchProfile(profileId, DEPLOYER_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { freezeAccounts: {} } },
      },
    });
    expect(status).toBe(403);
    expect(json.error?.code).toBe("INSUFFICIENT_PERMISSIONS");
  });

  it("rewrites extension rows when the selection changes on a pending token", async () => {
    const { tokenId, profileId } = await createPendingTokenWithProfile({
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { pauseTransfers: {} } },
      },
    });
    expect(await getToken(tokenId)).toMatchObject({ extensions: { pausable: {} } });
    expect(await extensionRows(tokenId)).toEqual(["pausable"]);

    // Clear the selection: the pending snapshot must drop the extension too.
    const { status } = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: {} },
      },
    });
    expect(status).toBe(200);

    const after = await getToken(tokenId);
    expect(after.extensions).toBeNull();
    expect(await extensionRows(tokenId)).toEqual([]);
    const row = await tokenRow(tokenId);
    expect(row?.template).toBe("custom");
  });

  it("rejects a policy change on a token that already deployed, but still saves non-policy metadata", async () => {
    const { tokenId, profileId } = await createPendingTokenWithProfile({
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { freezeAccounts: {} } },
      },
    });
    const mint = "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv";
    await getDb(env)
      .prepare(
        "UPDATE issued_tokens SET status = 'active', mint_address = ?, mint_authority = ?, deployed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .bind(mint, mint, tokenId)
      .run();

    // The mint is immutable: a policy change can never be applied to it.
    const rejected = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: {} },
      },
    });
    expect(rejected.status).toBe(409);

    // Non-policy saves keep working after deployment.
    const saved = await patchProfile(profileId, DEPLOYER_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token renamed" },
        settings: { selected: { freezeAccounts: {} } },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.data.assetProfile.issuanceMetadata.asset.name).toBe(
      "Snapshot Drift Token renamed"
    );
  });

  it("requires a signing wallet when the selection carries an authority-valued setting", async () => {
    const { profileId } = await createPendingTokenWithProfile();
    const { status, json } = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { permanentDelegate: {} } },
      },
    });
    expect(status).toBe(400);
    expect(json.error?.details?.errors).toEqual([
      { settingKey: "permanentDelegate", reason: "signing_wallet_required" },
    ]);
  });

  it("refuses deployment while the profile selection and the token snapshot diverge", async () => {
    const { tokenId } = await createPendingTokenWithProfile({
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { freezeAccounts: {} } },
      },
    });
    await seedDriftCustodyWallet();
    await getDb(env)
      .prepare(
        "UPDATE issued_tokens SET signing_custody_wallet_id = ?, signing_wallet_id = ? WHERE id = ?"
      )
      .bind(DRIFT_CUSTODY_WALLET_ID, DRIFT_PROVIDER_WALLET_ID, tokenId)
      .run();
    // Simulate pre-fix drift: the reviewed profile enables freezeAccounts while
    // the deployment snapshot still says the mint is not freezable.
    await getDb(env)
      .prepare("UPDATE issued_tokens SET freeze_authority_enabled = 0 WHERE id = ?")
      .bind(tokenId)
      .run();

    const createTokenSpy = vi.spyOn(MosaicService.prototype, "createToken");

    try {
      const response = await app.request(
        `/v1/issuance/tokens/${tokenId}/deploy`,
        {
          method: "POST",
          headers: headers(ADMIN_KEY.raw),
          body: JSON.stringify({}),
        },
        env
      );
      const json = await response.json();
      expect(response.status).toBe(409);
      expect(json.error?.message).toContain("asset profile");

      expect(createTokenSpy).not.toHaveBeenCalled();
      const row = await tokenRow(tokenId);
      expect(row?.status).toBe("pending");
      const txCount = await getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM issuance_transactions WHERE token_id = ?")
        .bind(tokenId)
        .first<{ count: number }>();
      expect(txCount).toEqual({ count: 0 });
    } finally {
      createTokenSpy.mockRestore();
    }
  });

  it("persists the resolver's freeze flag when settings drive creation", async () => {
    // CREATE_BODY already sends isFreezable: false; the freezeAccounts
    // selection is the reviewed policy and the resolver derives the flag from
    // it — persisting the caller's raw flag would fail this fresh token as
    // drifted at deploy time.
    const { tokenId } = await createPendingTokenWithProfile({
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { freezeAccounts: {} } },
      },
    });
    expect(await getToken(tokenId)).toMatchObject({ isFreezable: true });

    // The fresh token passes the deploy-time snapshot check: the deploy
    // advances past it and refuses later for the missing signing wallet
    // instead of the drift 409.
    const response = await app.request(
      `/v1/issuance/tokens/${tokenId}/deploy`,
      { method: "POST", headers: headers(ADMIN_KEY.raw), body: JSON.stringify({}) },
      env
    );
    const json = (await response.json()) as SuccessJson;
    expect(response.status).toBe(400);
    expect(json.error?.message).toContain("signingCustodyWalletId");
  });

  it("keeps freshly created authority-stamped extensions deployable without an extra save", async () => {
    // Mirrors the integration suite's transfer-fee deploy: creation stores the
    // caller's per-deployment authority fields, which the settings resolver
    // never reproduces — the deploy check must compare policy, not wallet
    // state, on both sides.
    const mint = "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv";
    const { tokenId } = await createPendingTokenWithProfile({
      overrides: {
        extensions: {
          transferFee: {
            basisPoints: 100,
            maxFee: "1000000000",
            transferFeeConfigAuthority: mint,
            withdrawWithheldAuthority: mint,
          },
        },
      },
    });

    const response = await app.request(
      `/v1/issuance/tokens/${tokenId}/deploy`,
      { method: "POST", headers: headers(ADMIN_KEY.raw), body: JSON.stringify({}) },
      env
    );
    const json = (await response.json()) as SuccessJson;
    expect(response.status).toBe(400);
    expect(json.error?.message).toContain("signingCustodyWalletId");

    const delegateToken = await createPendingTokenWithProfile({
      overrides: { extensions: { permanentDelegate: mint } },
    });
    const delegateResponse = await app.request(
      `/v1/issuance/tokens/${delegateToken.tokenId}/deploy`,
      { method: "POST", headers: headers(ADMIN_KEY.raw), body: JSON.stringify({}) },
      env
    );
    const delegateJson = (await delegateResponse.json()) as SuccessJson;
    expect(delegateResponse.status).toBe(400);
    expect(delegateJson.error?.message).toContain("signingCustodyWalletId");
  });

  it("governs category/type-only edits as compliance policy", async () => {
    const { tokenId, profileId } = await createPendingTokenWithProfile({
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { pauseTransfers: {} } },
      },
    });

    // The resolver derives the template (and freeze behavior) from the
    // category/type, so a tokens:write caller must not re-derive the policy
    // through the category selector alone.
    const denied = await patchProfile(profileId, DEPLOYER_KEY.raw, { assetCategory: "stablecoin" });
    expect(denied.status).toBe(403);
    expect(denied.json.error?.code).toBe("INSUFFICIENT_PERMISSIONS");

    // Admin-governed: the pending snapshot re-resolves for the new category.
    const saved = await patchProfile(profileId, ADMIN_KEY.raw, { assetCategory: "stablecoin" });
    expect(saved.status).toBe(200);
    expect(saved.json.data.token?.template).toBe("stablecoin");
    expect(await tokenRow(tokenId)).toMatchObject({ template: "stablecoin" });
  });

  it("refuses a deployed profile's category change (the mint's derived policy is immutable)", async () => {
    const { tokenId, profileId } = await createPendingTokenWithProfile({
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { pauseTransfers: {} } },
      },
    });
    const mint = "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv";
    await getDb(env)
      .prepare(
        "UPDATE issued_tokens SET status = 'active', mint_address = ?, mint_authority = ?, deployed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .bind(mint, mint, tokenId)
      .run();

    const rejected = await patchProfile(profileId, ADMIN_KEY.raw, { assetCategory: "stablecoin" });
    expect(rejected.status).toBe(409);
  });

  it("does not treat the dashboard's access-control round-trip as a deployed policy change", async () => {
    const { tokenId, profileId } = await createPendingTokenWithProfile();
    const mint = "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv";
    await getDb(env)
      .prepare(
        "UPDATE issued_tokens SET status = 'active', mint_address = ?, mint_authority = ?, deployed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .bind(mint, mint, tokenId)
      .run();

    // The dashboard re-derives the mode from the token's own columns (custom
    // template, no allowlist) and writes it back; the stored profile never
    // carried compliance.accessControl, so this save changes no effective
    // policy and must not trip the deployed-mint guard.
    const saved = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        compliance: { accessControl: "disabled" },
        settings: { selected: {} },
      },
    });
    expect(saved.status).toBe(200);

    // A genuine mode change is still a policy change on an immutable mint.
    const rejected = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        compliance: { accessControl: "allowlist" },
        settings: { selected: {} },
      },
    });
    expect(rejected.status).toBe(409);
  });

  it("refuses a snapshot-rewriting save while a prepared client-signed deploy is in flight", async () => {
    const { tokenId, profileId } = await createPendingTokenWithProfile({
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { pauseTransfers: {} } },
      },
    });

    // What prepareDeploy records when it hands the client a transaction built
    // from the current snapshot: a pending deploy marker for the mint it will
    // create.
    const tokenService = new TokenService(getDb(env));
    await tokenService.createTransaction({
      tokenId,
      organizationId: TEST_ORG.id,
      type: "deploy",
      params: {
        operation: "deploy",
        mode: "prepare",
        mint: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
      },
    });

    // Rewriting the snapshot now could strand the submitted mint: confirm
    // would hold the mint's on-chain authorities against the new snapshot and
    // refuse it with no way to record it.
    const fenced = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token" },
        settings: { selected: { freezeAccounts: {} } },
      },
    });
    expect(fenced.status).toBe(409);
    expect(fenced.json.error?.message).toContain("prepared client-signed deployment");

    // A value-identical save rewrites nothing and is harmless.
    const harmless = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token renamed" },
        settings: { selected: { pauseTransfers: {} } },
      },
    });
    expect(harmless.status).toBe(200);

    // Once the prepared transaction can no longer land (its blockhash expired
    // long before this fence window lapses), the fence lifts.
    await getDb(env)
      .prepare(
        "UPDATE issuance_transactions SET created_at = '2026-01-01T00:00:00.000Z' WHERE token_id = ? AND type = 'deploy'"
      )
      .bind(tokenId)
      .run();
    const afterExpiry = await patchProfile(profileId, ADMIN_KEY.raw, {
      issuanceMetadata: {
        asset: { name: "Snapshot Drift Token renamed" },
        settings: { selected: { freezeAccounts: {} } },
      },
    });
    expect(afterExpiry.status).toBe(200);
    expect(await getToken(tokenId)).toMatchObject({ isFreezable: true });
  });
});
