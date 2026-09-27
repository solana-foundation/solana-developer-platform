/**
 * Wallet-scope isolation on the Private Channels verified-wallet routes
 * (SOLA9-576).
 *
 * `GET /v1/private-channels/wallets` listed every verified wallet under the
 * project's default principal and `DELETE /v1/private-channels/wallets/:pubkey`
 * revoked any of them, gated only on the project-level `payments:*` permission.
 * A selected-wallet API key bound only to wallet A could therefore enumerate
 * wallet B's verified `walletId` + `pubkey` from the same project principal and
 * — with `payments:write` — revoke wallet B's Private Channels enrollment on
 * the unscoped delete surface.
 *
 * The invariant under test: a selected key lists only rows whose `wallet_id`
 * carries a FRESH `payments:read` binding, and may revoke only a wallet whose
 * binding carries a FRESH `payments:write` permission (a binding revoked in the
 * database is honored immediately, not after the KV cache window). The FRESH
 * top-level permission is enforced at both seams the same way, and the delete
 * path authorizes before the mirror lookup so mirror existence (verified vs
 * unverified pubkey) is never revealed to an unauthorized key. The delete
 * pubkey→wallet mapping spans both custody ownership paths, so a verified
 * connection-owned wallet stays revocable for a key bound to it. All-wallet
 * keys and dashboard actors keep the project-scoped behavior.
 *
 * The SPC auth boundary (`createAuthClient` + the SPC session mint) is the only
 * mock: the routes, API-key middleware, wallet-authorization refresh and the
 * tenant-scoped repositories are the real ones.
 */

import { hashString } from "@sdp/payments/hash";
import * as authPkg from "@sdp/private-channels/auth";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as spcSession from "@/services/private-channels/auth/spc-session";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const ORGANIZATION_ID = "org_pc_wallet_scope";
const PROJECT_ID = "prj_pc_wallet_scope";
const USER_ID = "usr_pc_wallet_scope";
const INSTANCE_ID = "pci_pc_wallet_scope";
const PRINCIPAL_ID = "pcu_pc_wallet_scope_default";
const WALLET_A_ID = "wallet_scope_a";
const WALLET_B_ID = "wallet_scope_b";
const WALLET_C_ID = "wallet_scope_c";
/** A project custody wallet owned by an ACTIVE CUSTODY CONNECTION (not a config). */
const WALLET_CONN_ID = "wallet_scope_conn";
const WALLET_A_PUBKEY = "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz";
const WALLET_B_PUBKEY = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
/** A project custody wallet with NO verified mirror (never SPC-verified). */
const WALLET_C_PUBKEY = "8XyBKraqNVWLqS1YnLjQXaWFikCMtLNjNLR7UVpPVsoP";
/** A pubkey mapping to no custody wallet at all. */
const UNKNOWN_PUBKEY = "7Kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
/** The verified pubkey of the connection-owned custody wallet. */
const WALLET_CONN_PUBKEY = "CcnW4L1CL8TqNf1V1yUh2pt1Y4M1QmeSfM1au2YcDuTP";

/** Selected-scope key bound to wallet A with read-only wallet permissions. */
const READ_KEY = {
  id: "key_pc_ws_read",
  raw: "sk_test_pc_wallet_scope_read",
  prefix: "sk_test_pwsr",
};
/** Selected-scope key bound to wallet A with write wallet permissions. */
const WRITE_KEY = {
  id: "key_pc_ws_write",
  raw: "sk_test_pc_wallet_scope_write",
  prefix: "sk_test_pwsw",
};
/** Stale-snapshot key: its KV cache still grants wallet B, the database does not. */
const STALE_KEY = {
  id: "key_pc_ws_stale",
  raw: "sk_test_pc_wallet_scope_stale",
  prefix: "sk_test_pwss",
};
/** All-wallet key: project-scoped behavior must be preserved. */
const ALL_KEY = {
  id: "key_pc_ws_all",
  raw: "sk_test_pc_wallet_scope_all",
  prefix: "sk_test_pwsa",
};
/** Selected-scope key bound to the unverified wallet C with write permissions. */
const C_WRITE_KEY = {
  id: "key_pc_ws_cwrite",
  raw: "sk_test_pc_wallet_scope_cwrite",
  prefix: "sk_test_pwsc",
};
/** Selected-scope key bound to the verified connection-owned wallet with write permissions. */
const CONN_WRITE_KEY = {
  id: "key_pc_ws_connwrite",
  raw: "sk_test_pc_wallet_scope_connwrite",
  prefix: "sk_test_pwsk",
};

interface VerifiedWalletDto {
  walletId: string;
  pubkey: string;
}

function selectedCachedKey(
  base: Pick<CachedApiKey, "id" | "organizationId" | "projectId">,
  permissions: string[],
  bindings: Array<{ walletId: string; permissions: string[] }>
): CachedApiKey {
  return {
    ...base,
    role: "api_admin",
    permissions: permissions as CachedApiKey["permissions"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: bindings[0]?.walletId ?? null,
    status: "active",
    expiresAt: null,
    walletScope: "selected",
    walletBindings: bindings.map((binding) => ({
      ...binding,
      permissions: binding.permissions as CachedApiKey["walletBindings"] extends
        | Array<{ permissions: infer P }>
        | undefined
        ? P
        : never,
      custodyWalletId: "",
    })),
  } as CachedApiKey;
}

async function seedKeys(): Promise<void> {
  const db = getDb(env);
  const keys = [
    {
      key: READ_KEY,
      permissions: ["payments:read"],
      bindings: [{ walletId: WALLET_A_ID, permissions: ["payments:read"] }],
      dbBindings: [{ walletId: WALLET_A_ID, permissions: ["payments:read"] }],
    },
    {
      key: WRITE_KEY,
      permissions: ["payments:read", "payments:write"],
      bindings: [{ walletId: WALLET_A_ID, permissions: ["payments:write"] }],
      dbBindings: [{ walletId: WALLET_A_ID, permissions: ["payments:write"] }],
    },
    {
      // The KV snapshot still grants wallet B; the DB row was revoked. A fresh
      // binding read must deny B immediately.
      key: STALE_KEY,
      permissions: ["payments:read", "payments:write"],
      bindings: [
        { walletId: WALLET_A_ID, permissions: ["payments:write"] },
        { walletId: WALLET_B_ID, permissions: ["payments:write"] },
      ],
      dbBindings: [{ walletId: WALLET_A_ID, permissions: ["payments:read", "payments:write"] }],
    },
    {
      key: ALL_KEY,
      permissions: ["payments:read", "payments:write"],
      bindings: [],
      dbBindings: [],
    },
    {
      key: C_WRITE_KEY,
      permissions: ["payments:read", "payments:write"],
      bindings: [{ walletId: WALLET_C_ID, permissions: ["payments:write"] }],
      dbBindings: [{ walletId: WALLET_C_ID, permissions: ["payments:write"] }],
    },
    {
      key: CONN_WRITE_KEY,
      permissions: ["payments:read", "payments:write"],
      bindings: [{ walletId: WALLET_CONN_ID, permissions: ["payments:write"] }],
      dbBindings: [{ walletId: WALLET_CONN_ID, permissions: ["payments:write"] }],
    },
  ];

  for (const entry of keys) {
    const keyHash = await hashString(entry.key.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(
      env,
      keyHash,
      selectedCachedKey(
        { id: entry.key.id, organizationId: ORGANIZATION_ID, projectId: PROJECT_ID },
        entry.permissions,
        entry.bindings
      )
    );
    await db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status, signing_wallet_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'api_admin', ?, 'active', ?)`
      )
      .bind(
        entry.key.id,
        ORGANIZATION_ID,
        PROJECT_ID,
        USER_ID,
        `PC wallet-scope key ${entry.key.id}`,
        entry.key.prefix,
        keyHash,
        JSON.stringify(entry.permissions),
        entry.bindings[0]?.walletId ?? null
      )
      .run();
    let index = 0;
    for (const binding of entry.dbBindings) {
      await db
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
           VALUES (?, ?, ?, ?)`
        )
        .bind(
          `akwp_${entry.key.id}_${index++}`,
          entry.key.id,
          binding.walletId,
          JSON.stringify(binding.permissions)
        )
        .run();
    }
  }
}

async function seedProjectState(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORGANIZATION_ID, "PC Wallet Scope Org", "pc-wallet-scope", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "pc-wallet-scope@example.com", 1, "active"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, default_wallet_id, status)
         VALUES ('cfg_pc_wallet_scope', ?, ?, 'privy', '{}', ?, 'active')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, WALLET_A_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES ('cwlt_scope_a', 'cfg_pc_wallet_scope', ?, ?, 'Scope wallet A', 'transfer', 'active'),
                ('cwlt_scope_b', 'cfg_pc_wallet_scope', ?, ?, 'Scope wallet B', 'transfer', 'active'),
                ('cwlt_scope_c', 'cfg_pc_wallet_scope', ?, ?, 'Scope wallet C', 'transfer', 'active')`
      )
      .bind(
        WALLET_A_ID,
        WALLET_A_PUBKEY,
        WALLET_B_ID,
        WALLET_B_PUBKEY,
        WALLET_C_ID,
        WALLET_C_PUBKEY
      ),
    // A project-scoped custody CONNECTION owning its own wallet — the second
    // ownership path the delete pubkey→wallet mapping must cover.
    db
      .prepare(
        `INSERT INTO provider_credentials
           (id, organization_id, project_id, provider, label, scope, source,
            storage_backend, status)
         VALUES ('cred_pc_wallet_scope', ?, ?, 'privy', 'Scope connection credential',
                 'project', 'runtime', 'runtime_env', 'active')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key)
         VALUES ('conn_pc_wallet_scope', ?, ?, 'privy', 'project', 'cred_pc_wallet_scope', ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
         VALUES ('cwlt_scope_conn', 'conn_pc_wallet_scope', ?, ?, 'Scope connection wallet',
                 'transfer', 'active')`
      )
      .bind(WALLET_CONN_ID, WALLET_CONN_PUBKEY),
    // Activate the connection once its default wallet exists (the active
    // lifecycle check + the default-wallet FK are circular on insert).
    db.prepare(
      `UPDATE custody_connections SET status = 'active', activated_at = '2026-01-01T00:00:00.000Z',
                last_check_status = 'success', last_check_at = '2026-01-01T00:00:00.000Z',
                default_custody_wallet_id = 'cwlt_scope_conn'
         WHERE id = 'conn_pc_wallet_scope'`
    ),
    db
      .prepare(
        `INSERT INTO private_channel_instances
           (id, organization_id, project_id, gateway_url, chain_rpc_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr,
            auth_url, is_active)
         VALUES (?, ?, ?, 'https://gateway.poc.invalid', 'https://rpc.poc.invalid',
                 'EscrowPoc111111111111111111111111111111111',
                 'WithdrawPoc1111111111111111111111111111111',
                 'InstancePoc11111111111111111111111111111111',
                 'https://auth.poc.invalid', true)`
      )
      .bind(INSTANCE_ID, ORGANIZATION_ID, PROJECT_ID),
    // Current (post-0073) principal shape: project-scoped, instance-keyed, no user_id.
    db
      .prepare(
        `INSERT INTO private_channel_users
           (id, organization_id, project_id, instance_id, name, is_default, provisioned_at,
            spc_user_id, spc_username, spc_credential_ciphertext)
         VALUES (?, ?, ?, ?, 'Default Principal', TRUE, '2026-01-01T00:00:00.000Z',
                 'spc_wallet_scope_default', 'wallet-scope-default', 'synthetic-ciphertext')`
      )
      .bind(PRINCIPAL_ID, ORGANIZATION_ID, PROJECT_ID, INSTANCE_ID),
    // All three custody wallets are verified under the same default principal.
    db
      .prepare(
        `INSERT INTO private_channel_verified_wallets
           (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey)
         VALUES ('pcvw_scope_a', ?, ?, ?, ?, ?, ?), ('pcvw_scope_b', ?, ?, ?, ?, ?, ?),
                 ('pcvw_scope_conn', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ORGANIZATION_ID,
        PROJECT_ID,
        PRINCIPAL_ID,
        INSTANCE_ID,
        WALLET_A_ID,
        WALLET_A_PUBKEY,
        ORGANIZATION_ID,
        PROJECT_ID,
        PRINCIPAL_ID,
        INSTANCE_ID,
        WALLET_B_ID,
        WALLET_B_PUBKEY,
        ORGANIZATION_ID,
        PROJECT_ID,
        PRINCIPAL_ID,
        INSTANCE_ID,
        WALLET_CONN_ID,
        WALLET_CONN_PUBKEY
      ),
  ]);
}

async function listVerifiedWalletRows(): Promise<Array<{ wallet_id: string; pubkey: string }>> {
  const rows = await getDb(env)
    .prepare("SELECT wallet_id, pubkey FROM private_channel_verified_wallets ORDER BY wallet_id")
    .all<{ wallet_id: string; pubkey: string }>();
  return rows.rows ?? [];
}

function headers(key: { raw: string }): Record<string, string> {
  return { Authorization: `Bearer ${key.raw}`, "Content-Type": "application/json" };
}

async function getWallets(key: { raw: string }) {
  const response = await app.request(
    "/v1/private-channels/wallets",
    { headers: headers(key) },
    env
  );
  const body = (await response.json()) as { data: { wallets: VerifiedWalletDto[] } };
  return { response, wallets: body.data.wallets };
}

describe("Private Channels wallet-scope validation (SOLA9-576)", () => {
  let originalPrivateChannelsEnabled: string | undefined;
  const deleteWalletMock = vi.fn<(token: string, pubkey: string) => Promise<void>>();

  beforeEach(async () => {
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedProjectState();
    await seedKeys();

    // Mock only the external SPC boundary. The session mint is stubbed so a
    // revocation that reaches SPC succeeds; the auth client records deletes.
    deleteWalletMock.mockReset();
    deleteWalletMock.mockResolvedValue(undefined);
    vi.spyOn(authPkg, "createAuthClient").mockReturnValue({
      login: vi.fn().mockResolvedValue({ token: "jwt-wallet-scope" }),
      challengeWallet: vi.fn(),
      verifyWallet: vi.fn(),
      deleteWallet: deleteWalletMock as unknown as (token: string, pubkey: string) => Promise<void>,
    } as never);
    vi.spyOn(spcSession, "getSpcSession").mockResolvedValue({
      token: "jwt-wallet-scope",
      username: "wallet-scope-default",
    });
  });

  afterEach(async () => {
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
    vi.restoreAllMocks();
    await clearKVStores(env);
  });

  it("GET returns only the bound wallet to a selected key bound to wallet A", async () => {
    const { response, wallets } = await getWallets(READ_KEY);

    expect(response.status).toBe(200);
    const returnedWalletIds = wallets.map((wallet) => wallet.walletId);
    const returnedPubkeys = wallets.map((wallet) => wallet.pubkey);
    // Positive baseline: the bound wallet A stays readable.
    expect(returnedWalletIds).toContain(WALLET_A_ID);
    // Invariant: wallet B is verified under the same project principal but is
    // not in the key's bindings — its proof must not be enumerable.
    expect(returnedWalletIds).not.toContain(WALLET_B_ID);
    expect(returnedPubkeys).not.toContain(WALLET_B_PUBKEY);
  });

  it("GET honors a binding revoked after the KV snapshot was taken", async () => {
    // STALE_KEY's KV snapshot still grants wallet B; only wallet A's binding
    // remains in the database. The fresh read must decide, not the cache.
    const { response, wallets } = await getWallets(STALE_KEY);

    expect(response.status).toBe(200);
    const returnedWalletIds = wallets.map((wallet) => wallet.walletId);
    expect(returnedWalletIds).toContain(WALLET_A_ID);
    expect(returnedWalletIds).not.toContain(WALLET_B_ID);
    expect(wallets.map((wallet) => wallet.pubkey)).not.toContain(WALLET_B_PUBKEY);
  });

  it("GET keeps the project-scoped listing for an all-wallet key", async () => {
    const { response, wallets } = await getWallets(ALL_KEY);

    expect(response.status).toBe(200);
    const returnedWalletIds = wallets.map((wallet) => wallet.walletId);
    expect(returnedWalletIds).toContain(WALLET_A_ID);
    expect(returnedWalletIds).toContain(WALLET_B_ID);
  });

  it("DELETE refuses an unbound wallet to a selected key and keeps its proof", async () => {
    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_B_PUBKEY}`,
      { method: "DELETE", headers: headers(WRITE_KEY) },
      env
    );

    expect(response.status).toBe(403);
    // The verification row must survive, and SPC must never be asked to revoke.
    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).toContain(WALLET_B_ID);
    expect(deleteWalletMock).not.toHaveBeenCalled();
  });

  it("DELETE refuses a wallet whose binding was revoked after the KV snapshot was taken", async () => {
    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_B_PUBKEY}`,
      { method: "DELETE", headers: headers(STALE_KEY) },
      env
    );

    expect(response.status).toBe(403);
    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).toContain(WALLET_B_ID);
    expect(deleteWalletMock).not.toHaveBeenCalled();
  });

  it("DELETE refuses a bound wallet lacking the payments:write binding", async () => {
    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_A_PUBKEY}`,
      { method: "DELETE", headers: headers(READ_KEY) },
      env
    );

    expect(response.status).toBe(403);
    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).toContain(WALLET_A_ID);
    expect(deleteWalletMock).not.toHaveBeenCalled();
  });

  it("GET refuses a key whose top-level payments:read was revoked after the KV snapshot", async () => {
    // The KV snapshot still grants payments:read, so the route middleware lets
    // the request through; the fresh top-level permission must decide.
    await getDb(env)
      .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify(["payments:write"]), ALL_KEY.id)
      .run();

    const response = await app.request(
      "/v1/private-channels/wallets",
      { headers: headers(ALL_KEY) },
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INSUFFICIENT_PERMISSIONS" },
    });
  });

  it("DELETE refuses a key whose top-level payments:write was revoked after the KV snapshot", async () => {
    await getDb(env)
      .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify(["payments:read"]), ALL_KEY.id)
      .run();

    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_B_PUBKEY}`,
      { method: "DELETE", headers: headers(ALL_KEY) },
      env
    );

    expect(response.status).toBe(403);
    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).toContain(WALLET_B_ID);
    expect(deleteWalletMock).not.toHaveBeenCalled();
  });

  it("DELETE does not reveal mirror existence to a selected key without the write binding", async () => {
    // Wallet C is a real project custody wallet with NO verified mirror, and
    // the unknown pubkey maps to no custody wallet at all. The pre-mirror
    // authorization must answer 403 for both — identical to the verified-but-
    // unbound case — so a write-capable selected key cannot probe which
    // pubkeys are verified.
    for (const pubkey of [WALLET_C_PUBKEY, UNKNOWN_PUBKEY]) {
      const response = await app.request(
        `/v1/private-channels/wallets/${pubkey}`,
        { method: "DELETE", headers: headers(WRITE_KEY) },
        env
      );
      expect(response.status).toBe(403);
    }

    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).toContain(WALLET_B_ID);
    expect(deleteWalletMock).not.toHaveBeenCalled();
  });

  it("DELETE answers 200 deleted:false for a selected key bound to an unverified wallet with a fresh write binding", async () => {
    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_C_PUBKEY}`,
      { method: "DELETE", headers: headers(C_WRITE_KEY) },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { deleted: false } });
    expect(deleteWalletMock).not.toHaveBeenCalled();
  });

  it("DELETE still revokes a wallet the selected key is bound to with payments:write", async () => {
    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_A_PUBKEY}`,
      { method: "DELETE", headers: headers(WRITE_KEY) },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { deleted: true } });
    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).not.toContain(WALLET_A_ID);
    expect(deleteWalletMock).toHaveBeenCalledWith("jwt-wallet-scope", WALLET_A_PUBKEY);
  });

  it("DELETE still revokes a verified connection-owned wallet for a selected key bound to it", async () => {
    // The connection wallet is verified and the key holds a fresh
    // payments:write binding for its walletId; the pre-mirror pubkey→wallet
    // mapping must span the connection ownership path, not just config-owned
    // wallets, or a valid binding would 403 before the mirror is consulted.
    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_CONN_PUBKEY}`,
      { method: "DELETE", headers: headers(CONN_WRITE_KEY) },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { deleted: true } });
    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).not.toContain(WALLET_CONN_ID);
    expect(deleteWalletMock).toHaveBeenCalledWith("jwt-wallet-scope", WALLET_CONN_PUBKEY);
  });

  it("DELETE keeps mirror existence hidden for an unbound connection-wallet pubkey", async () => {
    // WRITE_KEY is bound to wallet A only. The connection wallet's pubkey is
    // verified, so a lookup that leaks mirror existence would answer
    // deleted:false (200) instead of the uniform 403.
    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_CONN_PUBKEY}`,
      { method: "DELETE", headers: headers(WRITE_KEY) },
      env
    );

    expect(response.status).toBe(403);
    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).toContain(WALLET_CONN_ID);
    expect(deleteWalletMock).not.toHaveBeenCalled();
  });

  it("DELETE keeps the project-scoped revocation for an all-wallet key", async () => {
    const response = await app.request(
      `/v1/private-channels/wallets/${WALLET_B_PUBKEY}`,
      { method: "DELETE", headers: headers(ALL_KEY) },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { deleted: true } });
    const rows = await listVerifiedWalletRows();
    expect(rows.map((row) => row.wallet_id)).not.toContain(WALLET_B_ID);
    expect(deleteWalletMock).toHaveBeenCalledWith("jwt-wallet-scope", WALLET_B_PUBKEY);
  });
});
