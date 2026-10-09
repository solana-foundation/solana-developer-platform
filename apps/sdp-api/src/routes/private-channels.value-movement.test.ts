import assert from "node:assert/strict";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, PrivateChannelDeposit, PrivateChannelWithdrawal } from "@sdp/types";
import { PrivySigner } from "@solana/keychain-privy";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPrivateChannelDepositRepository,
  createPrivateChannelWithdrawalRepository,
} from "@/db/repositories";
import app from "@/index";
import { verifyClerkJwt } from "@/lib/clerk-token";
import {
  buildPrivateChannelDepositFingerprint,
  buildPrivateChannelWithdrawalFingerprint,
} from "@/lib/idempotency";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import {
  activateTestCustodyConnection,
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const { createChannelDepositMock, createChannelWithdrawalMock, resolveGatewayAuthMock } =
  vi.hoisted(() => ({
    createChannelDepositMock: vi.fn(),
    createChannelWithdrawalMock: vi.fn(),
    resolveGatewayAuthMock: vi.fn(),
  }));
const createProviderSigner = PrivySigner.create;
const providerSignerMock = vi.spyOn(PrivySigner, "create");
const originalPrivy = { appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET };

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

vi.mock("@/services/private-channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/private-channels")>();
  return {
    ...actual,
    createChannelDeposit: createChannelDepositMock,
    createChannelWithdrawal: createChannelWithdrawalMock,
  };
});

vi.mock("@/services/private-channels/auth/gateway-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/private-channels/auth/gateway-auth")>();
  return { ...actual, resolveGatewayAuth: resolveGatewayAuthMock };
});

const ORGANIZATION_ID = "org_test_pc_value";
const PROJECT_ID = "prj_pc_value";
let CLERK_TOKEN: string;

const ACTOR_USER_ID = "usr_test_pc_value_actor";
const COLLEAGUE_USER_ID = "usr_test_pc_value_colleague";
const NON_MEMBER_USER_ID = "usr_test_pc_value_non_member";
let NON_MEMBER_CLERK_TOKEN: string;
const INSTANCE_ID = "pci_pc_value";
const ACTOR_PC_USER_ID = "pcu_pc_value_actor";
const COLLEAGUE_PC_USER_ID = "pcu_pc_value_colleague";
const ACTOR_WALLET_ID = "wallet_pc_value_actor";
const COLLEAGUE_WALLET_ID = "wallet_pc_value_colleague";
const UNVERIFIED_WALLET_ID = "wallet_pc_value_unverified";
const ACTOR_ADDRESS = "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz";
const COLLEAGUE_ADDRESS = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
const UNVERIFIED_ADDRESS = "Vote111111111111111111111111111111111111111";

const EXTERNAL_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ESCROW_PROGRAM_ID = "EscrowProgram11111111111111111111111111111";
const WITHDRAW_PROGRAM_ID = "WithdrawProgram111111111111111111111111111";
const ESCROW_INSTANCE_ADDRESS = "EscrowInstance111111111111111111111111111";
const API_KEY = {
  id: "key_pc_value",
  raw: "sk_test_private_channel_value",
  prefix: "sk_test_pcv",
};

const SCOPED_API_KEY = {
  id: "key_pc_value_scoped",
  raw: "sk_test_private_channel_value_scoped",
  prefix: "sk_test_pcvs",
};

const UNSAFE_ADDRESSES = [
  ["system", "11111111111111111111111111111111"],
  ["token", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
  ["associated-token", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"],
  ["memo", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"],
  ["escrow program", ESCROW_PROGRAM_ID],
  ["withdraw program", WITHDRAW_PROGRAM_ID],
  ["escrow instance", ESCROW_INSTANCE_ADDRESS],
] as const;

let originalPrivateChannelsEnabled: string | undefined;
let originalEncryptionKey: string | undefined;

async function useConnectionSource() {
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString("base64");
  const db = getDb(env);
  await insertTestStoredProviderCredential(db, {
    id: "pcred-pcv",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    label: "PC",
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: ORGANIZATION_ID,
      credentialId: "pcred-pcv",
      appId: "pc-value-connection-app",
      appSecret: "pc-value-connection-secret",
    }),
    displayMetadata: {},
    status: "active",
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: ACTOR_USER_ID,
  });
  await insertTestCustodyConnection(db, {
    id: "conn-pcv",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    credential: { id: "pcred-pcv", projectId: PROJECT_ID },
    status: "pending",
    setupMetadata: {},
    providerAccountFingerprint: null,
    lastCheckStatus: null,
    lastCheckAt: null,
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
    createdBy: ACTOR_USER_ID,
    createdAt: new Date().toISOString(),
  });
  await db
    .prepare(`UPDATE custody_wallets SET custody_config_id = NULL, custody_connection_id = 'conn-pcv'
      WHERE id = 'cw-pcv-actor'`)
    .run();
  await activateTestCustodyConnection(db, {
    connectionId: "conn-pcv",
    custodyWalletId: "cw-pcv-actor",
    providerAccountFingerprint: "sha256:pc-value",
  });
}

function humanHeaders(extra: Record<string, string>) {
  return {
    Authorization: `Bearer ${CLERK_TOKEN}`,
    "x-project-id": PROJECT_ID,
    "Content-Type": "application/json",
    "Idempotency-Key": "idem_pc_value",
    ...extra,
  };
}

function apiKeyHeaders() {
  return {
    Authorization: `Bearer ${API_KEY.raw}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "idem_pc_value",
  };
}

function scopedApiKeyHeaders() {
  return { ...apiKeyHeaders(), Authorization: `Bearer ${SCOPED_API_KEY.raw}` };
}

function depositDto(overrides: Partial<PrivateChannelDeposit>): PrivateChannelDeposit {
  return {
    id: "dep_route_created",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    walletId: ACTOR_WALLET_ID,
    depositor: ACTOR_ADDRESS,
    recipient: ACTOR_ADDRESS,
    mint: EXTERNAL_ADDRESS,
    amount: "1.5",
    status: "submitted",
    signature: "signature-deposit",
    settlementRef: null,
    failureReason: null,
    context: {},
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

function withdrawalDto(overrides: Partial<PrivateChannelWithdrawal>): PrivateChannelWithdrawal {
  return {
    id: "wd_route_created",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    walletId: ACTOR_WALLET_ID,
    owner: ACTOR_ADDRESS,
    destination: ACTOR_ADDRESS,
    mint: EXTERNAL_ADDRESS,
    amount: "1.5",
    status: "submitted",
    signature: "signature-withdrawal",
    settlementRef: null,
    failureReason: null,
    context: {},
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

async function seedRouteState(): Promise<void> {
  const db = getDb(env);
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  const cachedApiKey: CachedApiKey = {
    id: API_KEY.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    role: "api_admin",
    permissions: ["payments:read", "payments:write"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
  await seedCachedApiKey(env, keyHash, cachedApiKey);
  await seedCachedApiKey(env, await hashString(SCOPED_API_KEY.raw, env.API_KEY_PEPPER), {
    ...cachedApiKey,
    id: SCOPED_API_KEY.id,
    walletScope: "selected",
    walletBindings: [{ walletId: COLLEAGUE_WALLET_ID, permissions: ["payments:write"] }],
  });

  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORGANIZATION_ID, "PC Value Org", "pc-value-org", "enterprise", "active"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status) VALUES
          (?, 'value-actor@example.com', 1, 'active'),
          (?, 'value-colleague@example.com', 1, 'active'),
          (?, 'value-nonmember@example.com', 1, 'active')`
      )
      .bind(ACTOR_USER_ID, COLLEAGUE_USER_ID, NON_MEMBER_USER_ID),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES
           ('om_pc_value_actor', ?, ?, 'admin', 'active'),
           ('om_pc_value_colleague', ?, ?, 'admin', 'active'),
           ('om_pc_value_nonmember', ?, ?, 'admin', 'active')`
      )
      .bind(
        ORGANIZATION_ID,
        ACTOR_USER_ID,
        ORGANIZATION_ID,
        COLLEAGUE_USER_ID,
        ORGANIZATION_ID,
        NON_MEMBER_USER_ID
      ),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: ACTOR_USER_ID,
    members: [ACTOR_USER_ID, COLLEAGUE_USER_ID, NON_MEMBER_USER_ID],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status)
         VALUES (?, ?, ?, ?, 'PC value key', ?, ?, 'api_admin', ?, 'active')`
      )
      .bind(
        API_KEY.id,
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_USER_ID,
        API_KEY.prefix,
        keyHash,
        JSON.stringify(cachedApiKey.permissions)
      ),
    db
      .prepare(
        `INSERT INTO private_channel_instances
           (id, organization_id, project_id, gateway_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
         VALUES (?, ?, ?, 'https://gateway.example', ?, ?, ?, 'https://auth.example', true)`
      )
      .bind(
        INSTANCE_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        ESCROW_PROGRAM_ID,
        WITHDRAW_PROGRAM_ID,
        ESCROW_INSTANCE_ADDRESS
      ),
    db
      .prepare(`INSERT INTO api_keys
      (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
      VALUES (?, ?, ?, ?, 'Scoped PC key', ?, ?, 'api_admin', ?, 'active')`)
      .bind(
        SCOPED_API_KEY.id,
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_USER_ID,
        SCOPED_API_KEY.prefix,
        await hashString(SCOPED_API_KEY.raw, env.API_KEY_PEPPER),
        JSON.stringify(cachedApiKey.permissions)
      ),
    db
      .prepare(`INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
      VALUES ('akwp-pcv', ?, ?, ?)`)
      .bind(SCOPED_API_KEY.id, COLLEAGUE_WALLET_ID, JSON.stringify(["payments:write"])),
    db
      .prepare(
        `INSERT INTO private_channel_users
           (id, organization_id, project_id, instance_id, is_default, provisioned_at,
            spc_user_id, spc_username, spc_credential_ciphertext)
         VALUES
           (?, ?, ?, ?, TRUE, '2026-01-01T00:00:00.000Z',
            'spc-value-actor', 'value-actor', 'cipher-actor'),
           (?, ?, ?, ?, FALSE, '2026-01-01T00:00:00.000Z',
            'spc-value-colleague', 'value-colleague', 'cipher-colleague')`
      )
      .bind(
        ACTOR_PC_USER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        INSTANCE_ID,
        COLLEAGUE_PC_USER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        INSTANCE_ID
      ),
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cust-pcv', ?, ?, 'privy', '{}', 'active')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES
           ('cw-pcv-actor', 'cust-pcv', ?, ?, 'Actor', 'transfer', 'active'),
           ('cw-pcv-colleague', 'cust-pcv', ?, ?, 'Colleague', 'transfer', 'active'),
           ('cw-pcv-unverified', 'cust-pcv', ?, ?, 'Unverified', 'transfer', 'active')`
      )
      .bind(
        ACTOR_WALLET_ID,
        ACTOR_ADDRESS,
        COLLEAGUE_WALLET_ID,
        COLLEAGUE_ADDRESS,
        UNVERIFIED_WALLET_ID,
        UNVERIFIED_ADDRESS
      ),

    db
      .prepare(
        `INSERT INTO private_channel_verified_wallets
           (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey)
         VALUES ('pcvw-pcv-actor', ?, ?, ?, ?, ?, ?), ('pcvw-pcv-colleague', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_PC_USER_ID,
        INSTANCE_ID,
        ACTOR_WALLET_ID,
        ACTOR_ADDRESS,
        ORGANIZATION_ID,
        PROJECT_ID,
        COLLEAGUE_PC_USER_ID,
        INSTANCE_ID,
        COLLEAGUE_WALLET_ID,
        COLLEAGUE_ADDRESS
      ),
  ]);
}

async function postDeposit(body: Record<string, unknown>, headers: Record<string, string>) {
  return app.request(
    "/v1/private-channels/deposits",
    { method: "POST", headers, body: JSON.stringify(body) },
    env
  );
}

async function postWithdrawal(body: Record<string, unknown>, headers: Record<string, string>) {
  return app.request(
    "/v1/private-channels/withdrawals",
    { method: "POST", headers, body: JSON.stringify(body) },
    env
  );
}

async function recordedDeposit(recipient: string) {
  return createPrivateChannelDepositRepository(env).createDeposit({
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    walletId: ACTOR_WALLET_ID,
    depositor: ACTOR_ADDRESS,
    recipient,
    mint: EXTERNAL_ADDRESS,
    amount: "1.5",
    context: {},
    idempotencyKey: "idem_pc_value",
    idempotencyFingerprint: buildPrivateChannelDepositFingerprint({
      instanceId: INSTANCE_ID,
      walletId: ACTOR_WALLET_ID,
      recipient,
      mint: EXTERNAL_ADDRESS,
      amount: "1.5",
    }),
  });
}

async function recordedWithdrawal(destination: string) {
  const row = await createPrivateChannelWithdrawalRepository(env).createWithdrawal({
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    walletId: ACTOR_WALLET_ID,
    owner: ACTOR_ADDRESS,
    destination,
    mint: EXTERNAL_ADDRESS,
    amount: "1.5",
    context: {},
    idempotencyKey: "idem_pc_value",
    idempotencyFingerprint: buildPrivateChannelWithdrawalFingerprint({
      instanceId: INSTANCE_ID,
      walletId: ACTOR_WALLET_ID,
      destination,
      mint: EXTERNAL_ADDRESS,
      amount: "1.5",
    }),
  });
  assert(row);
  return row;
}

async function abandonedWithdrawal() {
  const row = await recordedWithdrawal(ACTOR_ADDRESS);
  await getDb(env)
    .prepare("UPDATE private_channel_withdrawals SET updated_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 11 * 60_000).toISOString(), row.id)
    .run();
  return row;
}

async function setKeyPermissions(permissions: string[]) {
  await getDb(env)
    .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
    .bind(JSON.stringify(permissions), API_KEY.id)
    .run();
}

describe("Private Channels — deposit and withdrawal access", () => {
  afterAll(() => {
    providerSignerMock.mockRestore();
    env.PRIVY_APP_ID = originalPrivy.appId;
    env.PRIVY_APP_SECRET = originalPrivy.appSecret;
  });
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    env.PRIVY_APP_ID = "pc-value-app";
    env.PRIVY_APP_SECRET = "pc-value-secret";
    providerSignerMock.mockReset().mockImplementation(createProviderSigner);
    await seedTestDatabase(env);
    await seedRouteState();
    CLERK_TOKEN = await signSeededClerkMember(env, getDb(env), ACTOR_USER_ID, ORGANIZATION_ID);
    NON_MEMBER_CLERK_TOKEN = await signSeededClerkMember(
      env,
      getDb(env),
      NON_MEMBER_USER_ID,
      ORGANIZATION_ID
    );
    await verifyClerkJwt(CLERK_TOKEN, env);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ address: ACTOR_ADDRESS, chain_type: "solana", id: ACTOR_WALLET_ID })
      )
    );
    createChannelDepositMock.mockReset();
    createChannelWithdrawalMock.mockReset();
    resolveGatewayAuthMock.mockReset();
    createChannelDepositMock.mockResolvedValue(depositDto({}));
    createChannelWithdrawalMock.mockResolvedValue(withdrawalDto({}));
    resolveGatewayAuthMock.mockResolvedValue({
      current: "spc-jwt",
      refresh: vi.fn(async () => "spc-jwt"),
      pcUserId: ACTOR_PC_USER_ID,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
    env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
    await clearKVStores(env);
  });

  it.each([false, true])(
    "uses role permissions when explicit permissions are absent (replay=%s)",
    async (replay) => {
      if (replay) {
        await recordedDeposit(ACTOR_ADDRESS);
        await recordedWithdrawal(ACTOR_ADDRESS);
      }
      await getDb(env)
        .prepare("UPDATE api_keys SET permissions = NULL WHERE id = ?")
        .bind(API_KEY.id)
        .run();
      await clearKVStores(env);

      for (const post of [postDeposit, postWithdrawal]) {
        const response = await post({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, apiKeyHeaders());
        expect(response.status).toBe(200);
      }
      if (replay) expect(providerSignerMock).not.toHaveBeenCalled();
    }
  );

  it("uses the current role instead of the cached role when permissions are absent", async () => {
    const original = await recordedDeposit(ACTOR_ADDRESS);
    await getDb(env)
      .prepare("UPDATE api_keys SET role = 'api_readonly', permissions = NULL WHERE id = ?")
      .bind(API_KEY.id)
      .run();
    const body = { walletId: ACTOR_WALLET_ID, amount: "1.5" };
    expect((await postWithdrawal(body, apiKeyHeaders())).status).toBe(403);
    expect((await postDeposit(body, apiKeyHeaders())).status).toBe(403);
    const history = await app.request(
      `/v1/private-channels/deposits/${required(original).id}`,
      { headers: apiKeyHeaders() },
      env
    );
    expect(history.status).toBe(200);
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
  });

  it.each([{ permissions: [] }, { permissions: ["wallets:read"] }])(
    "does not inherit role permissions for explicit permissions $permissions",
    async ({ permissions }) => {
      await recordedDeposit(ACTOR_ADDRESS);
      await setKeyPermissions(permissions);
      const body = { walletId: ACTOR_WALLET_ID, amount: "1.5" };
      expect((await postWithdrawal(body, apiKeyHeaders())).status).toBe(403);
      expect((await postDeposit(body, apiKeyHeaders())).status).toBe(403);
      expect(providerSignerMock).not.toHaveBeenCalled();
      expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    "not json",
    '"payments:write"',
    "{}",
    "null",
    '["payments:write", 42]',
    '["payments:write", "unknown:permission"]',
  ])("rejects malformed stored permissions before execution: %s", async (permissions) => {
    await getDb(env)
      .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
      .bind(permissions, API_KEY.id)
      .run();

    for (const replay of [false, true]) {
      if (replay) await recordedDeposit(ACTOR_ADDRESS);
      const response = await postDeposit(
        { walletId: ACTOR_WALLET_ID, amount: "1.5" },
        apiKeyHeaders()
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: "INTERNAL_ERROR", message: "Stored API key permissions are invalid" },
      });
    }
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
  });

  it("requires write for deposit replay and keeps history readable", async () => {
    const repo = createPrivateChannelDepositRepository(env);
    const original = await repo.createDeposit({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      walletId: ACTOR_WALLET_ID,
      depositor: ACTOR_ADDRESS,
      recipient: ACTOR_ADDRESS,
      mint: EXTERNAL_ADDRESS,
      amount: "1.5",
      context: {},
      idempotencyKey: "idem_pc_value",
      idempotencyFingerprint: buildPrivateChannelDepositFingerprint({
        instanceId: INSTANCE_ID,
        walletId: ACTOR_WALLET_ID,
        recipient: ACTOR_ADDRESS,
        mint: EXTERNAL_ADDRESS,
        amount: "1.5",
      }),
    });
    await getDb(env).batch([
      getDb(env).prepare(
        "UPDATE custody_wallets SET status = 'inactive' WHERE id = 'cw-pcv-actor'"
      ),
      getDb(env)
        .prepare("UPDATE private_channel_instances SET is_active = false WHERE id = ?")
        .bind(INSTANCE_ID),
      getDb(env)
        .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
        .bind(JSON.stringify(["payments:read"]), API_KEY.id),
    ]);
    await clearKVStores(env);

    const response = await postDeposit(
      { walletId: ACTOR_WALLET_ID, amount: "1.500" },
      apiKeyHeaders()
    );

    expect(response.status).toBe(403);
    const history = await app.request(
      `/v1/private-channels/deposits/${required(original).id}`,
      { headers: apiKeyHeaders() },
      env
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      data: { id: required(original).id, status: "pending" },
    });
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
  });

  it("refuses verification of a wallet outside the key's current wallet grants", async () => {
    const response = await app.request(
      `/v1/private-channels/wallets/${ACTOR_WALLET_ID}/verify`,
      {
        method: "POST",
        headers: scopedApiKeyHeaders(),
        body: "{}",
      },
      env
    );
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain(
      "not authorized for the requested wallet"
    );
  });

  it("requires the original source for withdrawal replay while history remains readable", async () => {
    const original = await createPrivateChannelWithdrawalRepository(env).createWithdrawal({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      walletId: ACTOR_WALLET_ID,
      owner: ACTOR_ADDRESS,
      destination: ACTOR_ADDRESS,
      mint: EXTERNAL_ADDRESS,
      amount: "1.5",
      context: {},
      idempotencyKey: "idem_pc_value",
      idempotencyFingerprint: buildPrivateChannelWithdrawalFingerprint({
        instanceId: INSTANCE_ID,
        walletId: ACTOR_WALLET_ID,
        destination: ACTOR_ADDRESS,
        mint: EXTERNAL_ADDRESS,
        amount: "1.5",
      }),
    });
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = 'cw-pcv-actor'")
      .run();
    const response = await postWithdrawal(
      { walletId: ACTOR_WALLET_ID, amount: "1.500" },
      humanHeaders({})
    );
    expect(response.status).toBe(404);
    const history = await app.request(
      `/v1/private-channels/withdrawals/${required(original).id}`,
      { headers: humanHeaders({}) },
      env
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      data: { id: required(original).id, status: "pending" },
    });
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
  });

  it("rejects new Connection deposits and withdrawals before opening an SPC session while BYOK is out of channel", async () => {
    await useConnectionSource();
    custodyReleaseChannel.outOfChannelMode = "byok";
    for (const post of [postDeposit, postWithdrawal]) {
      const response = await post({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "FORBIDDEN",
          message: custodyProviderNotInReleaseChannel("privy", "byok").message,
          details: { reason: "custody_provider_not_in_release_channel" },
        },
        meta: { requestId: expect.any(String) },
      });
    }
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
    expect(providerSignerMock).not.toHaveBeenCalled();
  });

  it("uses an active nondefault Connection for both movements", async () => {
    await useConnectionSource();
    for (const post of [postDeposit, postWithdrawal]) {
      expect(
        (await post({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
      ).toBe(200);
    }
    expect(providerSignerMock).toHaveBeenCalledTimes(2);
    expect(providerSignerMock).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: ACTOR_WALLET_ID, appId: "pc-value-connection-app" })
    );
  });

  it("preserves Config execution while BYOK is out of channel", async () => {
    custodyReleaseChannel.outOfChannelMode = "byok";
    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(200);
    expect(
      (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(200);
  });

  it.each(["credential", "entitlement"])(
    "denies unavailable Connection %s before signer and SPC access",
    async (reason) => {
      await useConnectionSource();
      if (reason === "credential") {
        await getDb(env)
          .prepare("UPDATE provider_credentials SET status = 'retired' WHERE id = 'pcred-pcv'")
          .run();
      } else {
        await getDb(env)
          .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
          .bind(
            JSON.stringify({ providerOverrides: { custody: { privy: false } } }),
            ORGANIZATION_ID
          )
          .run();
      }
      for (const post of [postDeposit, postWithdrawal]) {
        expect(
          (await post({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
        ).toBe(reason === "credential" ? 409 : 403);
      }
      expect(providerSignerMock).not.toHaveBeenCalled();
      expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
    }
  );

  it.each([ACTOR_WALLET_ID, ACTOR_ADDRESS])(
    "rejects ambiguous source %s before provider access",
    async (selector) => {
      await useConnectionSource();
      await getDb(env)
        .prepare(`INSERT INTO custody_wallets
      (id, custody_config_id, wallet_id, public_key, status) VALUES ('cw-pcv-duplicate', 'cust-pcv', ?, ?, 'active')`)
        .bind(ACTOR_WALLET_ID, ACTOR_ADDRESS)
        .run();
      expect(
        (await postDeposit({ walletId: selector, amount: "1.5" }, humanHeaders({}))).status
      ).toBe(409);
      expect(
        (await postWithdrawal({ walletId: selector, amount: "1.5" }, humanHeaders({}))).status
      ).toBe(409);
      expect(providerSignerMock).not.toHaveBeenCalled();
      expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
    }
  );

  it.each(["wallet", "owner", "provider ID"])(
    "rejects an address selector colliding with an inactive Connection %s instead of selecting Config",
    async (inactive) => {
      await useConnectionSource();
      const db = getDb(env);
      await db
        .prepare(`INSERT INTO custody_wallets
        (id, custody_config_id, wallet_id, public_key, status)
        VALUES ('cw-pcv-address-replacement', 'cust-pcv', 'wallet_address_replacement', ?, 'active')`)
        .bind(ACTOR_ADDRESS)
        .run();
      await db
        .prepare(
          inactive !== "owner"
            ? "UPDATE custody_wallets SET status = 'inactive' WHERE id = 'cw-pcv-actor'"
            : "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = 'conn-pcv'"
        )
        .run();
      if (inactive === "provider ID") {
        await db
          .prepare(
            "UPDATE custody_wallets SET wallet_id = ?, public_key = ? WHERE id = 'cw-pcv-actor'"
          )
          .bind(ACTOR_ADDRESS, COLLEAGUE_ADDRESS)
          .run();
      }
      await db
        .prepare(
          "UPDATE private_channel_verified_wallets SET wallet_id = 'wallet_address_replacement' WHERE pubkey = ?"
        )
        .bind(ACTOR_ADDRESS)
        .run();
      for (const post of [postDeposit, postWithdrawal]) {
        expect(
          (await post({ walletId: ACTOR_ADDRESS, amount: "1.5" }, humanHeaders({}))).status
        ).toBe(409);
      }
      expect(providerSignerMock).not.toHaveBeenCalled();
      expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
    }
  );

  it("accepts a counterparty address shared by custody records when the destination address is unambiguous", async () => {
    await getDb(env)
      .prepare(`INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
      VALUES ('cw-pcv-shared-recipient', 'cust-pcv', 'wallet_shared_recipient', ?, 'active')`)
      .bind(COLLEAGUE_ADDRESS)
      .run();
    expect(
      (
        await postDeposit(
          {
            walletId: ACTOR_WALLET_ID,
            amount: "1.5",
            recipient: COLLEAGUE_ADDRESS,
          },
          humanHeaders({})
        )
      ).status
    ).toBe(200);
    expect(
      (
        await postWithdrawal(
          {
            walletId: ACTOR_WALLET_ID,
            amount: "1.5",
            destination: COLLEAGUE_ADDRESS,
          },
          humanHeaders({})
        )
      ).status
    ).toBe(200);
  });

  it("denies stale all-wallet access after the key is restricted in the database", async () => {
    await recordedDeposit(ACTOR_ADDRESS);
    await getDb(env)
      .prepare(`INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
      VALUES ('akwp-pcv-restricted', ?, ?, '["payments:write"]')`)
      .bind(API_KEY.id, COLLEAGUE_WALLET_ID)
      .run();
    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, apiKeyHeaders())).status
    ).toBe(403);
    expect(
      (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, apiKeyHeaders())).status
    ).toBe(403);
    expect(providerSignerMock).not.toHaveBeenCalled();
  });

  it("denies revoked API keys even when their cached permissions allow replay", async () => {
    await recordedDeposit(ACTOR_ADDRESS);
    await getDb(env)
      .prepare("UPDATE api_keys SET status = 'revoked', permissions = NULL WHERE id = ?")
      .bind(API_KEY.id)
      .run();
    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, apiKeyHeaders())).status
    ).toBe(403);
    expect(providerSignerMock).not.toHaveBeenCalled();
  });

  it("rejects recovery after authorization discovers that the key was revoked", async () => {
    const original = await abandonedWithdrawal();
    const listWallets = CustodyRuntimeTargets.prototype.listWallets;
    const inventory = vi
      .spyOn(CustodyRuntimeTargets.prototype, "listWallets")
      .mockImplementationOnce(async function (this: CustodyRuntimeTargets, params) {
        await getDb(env)
          .prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?")
          .bind(API_KEY.id)
          .run();
        return listWallets.call(this, params);
      });
    try {
      const response = await postWithdrawal(
        { walletId: ACTOR_WALLET_ID, amount: "1.5" },
        apiKeyHeaders()
      );
      expect(response.status).toBe(403);
      expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
      expect(
        await createPrivateChannelWithdrawalRepository(env).getWithdrawalById({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          id: original.id,
        })
      ).toMatchObject({ status: "pending" });
    } finally {
      inventory.mockRestore();
    }
  });

  it("does not create new work for a read-only key", async () => {
    await setKeyPermissions(["payments:read"]);
    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, apiKeyHeaders())).status
    ).toBe(403);
    expect(
      (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, apiKeyHeaders())).status
    ).toBe(403);
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
  });

  it("preserves write-only deposit and withdrawal replay while BYOK is out of channel", async () => {
    const deposit = await recordedDeposit(ACTOR_ADDRESS);
    const withdrawal = await recordedWithdrawal(ACTOR_ADDRESS);
    await useConnectionSource();
    custodyReleaseChannel.outOfChannelMode = "byok";
    await setKeyPermissions(["payments:write"]);
    for (const { post, id } of [
      { post: postDeposit, id: required(deposit).id },
      { post: postWithdrawal, id: withdrawal.id },
    ]) {
      const response = await post({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, apiKeyHeaders());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { id, status: "pending" } });
    }
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
  });

  it("refuses to authorize a replacement source for replay while history remains readable", async () => {
    const original = await recordedDeposit(ACTOR_ADDRESS);
    await useConnectionSource();
    await getDb(env).batch([
      getDb(env).prepare(
        "UPDATE custody_wallets SET status = 'inactive' WHERE id = 'cw-pcv-actor'"
      ),
      getDb(env)
        .prepare(`INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
        VALUES ('cw-pcv-replacement', 'cust-pcv', ?, ?, 'active')`)
        .bind(ACTOR_WALLET_ID, EXTERNAL_ADDRESS),
    ]);
    const body = { walletId: ACTOR_WALLET_ID, amount: "1.5" };
    expect((await postDeposit(body, apiKeyHeaders())).status).toBe(409);
    const read = await app.request(
      `/v1/private-channels/deposits/${required(original).id}`,
      { headers: apiKeyHeaders() },
      env
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      data: { id: required(original).id, depositor: ACTOR_ADDRESS },
    });
    expect(providerSignerMock).not.toHaveBeenCalled();
  });

  it.each([
    { amount: "2" },
    { mint: COLLEAGUE_ADDRESS },
    { recipient: COLLEAGUE_ADDRESS },
    { walletId: COLLEAGUE_WALLET_ID },
    { recipient: COLLEAGUE_WALLET_ID },
  ])("conflicts on changed or unprovable historical payload %j", async (changed) => {
    await recordedDeposit(ACTOR_ADDRESS);
    expect(
      (
        await postDeposit(
          { walletId: ACTOR_WALLET_ID, amount: "1.5", ...changed },
          humanHeaders({})
        )
      ).status
    ).toBe(409);
    expect(providerSignerMock).not.toHaveBeenCalled();
  });

  it("replays a deposit whose recipient was named by walletId", async () => {
    const original = await recordedDeposit(COLLEAGUE_ADDRESS);
    const response = await postDeposit(
      {
        walletId: ACTOR_WALLET_ID,
        amount: "1.5",
        recipient: COLLEAGUE_WALLET_ID,
      },
      humanHeaders({})
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { id: required(original).id, recipient: COLLEAGUE_ADDRESS },
    });
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(createChannelDepositMock).not.toHaveBeenCalled();
  });

  it("replays a deposit whose recipient is the source named by walletId", async () => {
    const original = await recordedDeposit(ACTOR_ADDRESS);
    const response = await postDeposit(
      {
        walletId: ACTOR_WALLET_ID,
        amount: "1.5",
        recipient: ACTOR_WALLET_ID,
      },
      humanHeaders({})
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { id: required(original).id, recipient: ACTOR_ADDRESS },
    });
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(createChannelDepositMock).not.toHaveBeenCalled();
  });

  it("replays a withdrawal whose destination was named by walletId", async () => {
    const original = await recordedWithdrawal(COLLEAGUE_ADDRESS);
    const response = await postWithdrawal(
      {
        walletId: ACTOR_WALLET_ID,
        amount: "1.5",
        destination: COLLEAGUE_WALLET_ID,
      },
      humanHeaders({})
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { id: original.id, destination: COLLEAGUE_ADDRESS },
    });
    expect(providerSignerMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires write for abandoned withdrawal recovery (write=%s)",
    async (write) => {
      const original = await abandonedWithdrawal();
      await useConnectionSource();
      custodyReleaseChannel.outOfChannelMode = "byok";
      await setKeyPermissions(write ? ["payments:read", "payments:write"] : ["payments:read"]);
      const response = await postWithdrawal(
        { walletId: ACTOR_WALLET_ID, amount: "1.5" },
        apiKeyHeaders()
      );
      expect(response.status).toBe(write ? 200 : 403);
      const history = await app.request(
        `/v1/private-channels/withdrawals/${original.id}`,
        { headers: apiKeyHeaders() },
        env
      );
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({
        data: { id: original.id, status: write ? "failed" : "pending" },
      });
      expect(resolveGatewayAuthMock).toHaveBeenCalledTimes(write ? 1 : 0);
      expect(providerSignerMock).not.toHaveBeenCalled();
    }
  );

  it("fails signer setup before opening an SPC session", async () => {
    providerSignerMock.mockRejectedValue(new Error("provider unavailable"));
    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(503);
    expect(
      (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(503);
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it("refuses a value movement when the project has no active principal", async () => {
    await getDb(env)
      .prepare("UPDATE private_channel_users SET is_default = FALSE WHERE id = ?")
      .bind(ACTOR_PC_USER_ID)
      .run();

    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(403);
    expect(
      (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(403);
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a non-member Clerk user",
      () => humanHeaders({ Authorization: `Bearer ${NON_MEMBER_CLERK_TOKEN}` }),
    ],
    ["an API key", apiKeyHeaders],
  ])("refuses an unenrolled wallet for %s", async (_label, buildHeaders) => {
    const headers = buildHeaders();

    expect(
      (await postDeposit({ walletId: UNVERIFIED_WALLET_ID, amount: "1.5" }, headers)).status
    ).toBe(403);
    expect(
      (await postWithdrawal({ walletId: UNVERIFIED_WALLET_ID, amount: "1.5" }, headers)).status
    ).toBe(403);
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it("refuses a selected-scope API key naming an enrolled wallet it is not bound to", async () => {
    const headers = scopedApiKeyHeaders();

    const deposit = await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, headers);
    const withdrawal = await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, headers);

    expect(deposit.status).toBe(403);
    expect(withdrawal.status).toBe(403);
    expect(JSON.stringify(await deposit.json())).toContain(
      "not authorized for the requested wallet"
    );
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it("refuses a custody wallet that is not enrolled under the principal", async () => {
    expect(
      (await postDeposit({ walletId: UNVERIFIED_WALLET_ID, amount: "1.5" }, humanHeaders({})))
        .status
    ).toBe(403);
    expect(
      (await postWithdrawal({ walletId: UNVERIFIED_WALLET_ID, amount: "1.5" }, humanHeaders({})))
        .status
    ).toBe(403);
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it("does not let a caller move funds out of another principal's verified wallet", async () => {
    expect(
      (await postDeposit({ walletId: COLLEAGUE_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(403);
    expect(
      (await postWithdrawal({ walletId: COLLEAGUE_WALLET_ID, amount: "1.5" }, humanHeaders({})))
        .status
    ).toBe(403);
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it("credits only addresses verified on this instance", async () => {
    const external = await postDeposit(
      {
        walletId: ACTOR_WALLET_ID,
        amount: "1.5",
        recipient: EXTERNAL_ADDRESS,
      },
      humanHeaders({})
    );
    expect(external.status).toBe(400);
    expect(createChannelDepositMock).not.toHaveBeenCalled();

    const colleague = await postDeposit(
      {
        walletId: ACTOR_WALLET_ID,
        amount: "1.5",
        recipient: COLLEAGUE_ADDRESS,
      },
      humanHeaders({})
    );
    expect(colleague.status).toBe(200);
    expect(createChannelDepositMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipient: COLLEAGUE_ADDRESS })
    );
  });

  it.each(UNSAFE_ADDRESSES)(
    "rejects the %s address as a deposit recipient or withdrawal destination",
    async (_label, unsafe) => {
      expect(
        (
          await postDeposit(
            { walletId: ACTOR_WALLET_ID, amount: "1.5", recipient: unsafe },
            humanHeaders({})
          )
        ).status
      ).toBe(400);
      expect(
        (
          await postWithdrawal(
            { walletId: ACTOR_WALLET_ID, amount: "1.5", destination: unsafe },
            humanHeaders({})
          )
        ).status
      ).toBe(400);
      expect(createChannelDepositMock).not.toHaveBeenCalled();
      expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
    }
  );

  it("allows an unverified withdrawal destination", async () => {
    const response = await postWithdrawal(
      {
        walletId: ACTOR_WALLET_ID,
        amount: "1.5",
        destination: EXTERNAL_ADDRESS,
      },
      humanHeaders({})
    );

    expect(response.status).toBe(200);
    expect(createChannelWithdrawalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destination: EXTERNAL_ADDRESS })
    );
  });

  it("refuses to move funds without an idempotency key", async () => {
    const headers = humanHeaders({});
    const { "Idempotency-Key": _omitted, ...withoutKey } = headers;

    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, withoutKey)).status
    ).toBe(400);
    expect(
      (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, withoutKey)).status
    ).toBe(400);

    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it("hands the service the resolved wallet, counterparty, acting member and key", async () => {
    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(200);
    expect(createChannelDepositMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        userId: ACTOR_USER_ID,
        wallet: expect.objectContaining({
          walletId: ACTOR_WALLET_ID,
          publicKey: ACTOR_ADDRESS,
        }),

        recipient: ACTOR_ADDRESS,
        idempotencyKey: "idem_pc_value",
      })
    );

    expect(
      (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, humanHeaders({}))).status
    ).toBe(200);
    expect(createChannelWithdrawalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        userId: ACTOR_USER_ID,
        wallet: expect.objectContaining({ walletId: ACTOR_WALLET_ID }),
        destination: ACTOR_ADDRESS,
        idempotencyKey: "idem_pc_value",
      })
    );
  });
});
