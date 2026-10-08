import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, PrivateChannelTransfer } from "@sdp/types";
import { PrivySigner } from "@solana/keychain-privy";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPrivateChannelTransferRepository } from "@/db/repositories";
import app from "@/index";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { buildPrivateChannelTransferFingerprint } from "@/lib/idempotency";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { TEST_PRODUCTION_API_KEY } from "@/test/fixtures/api-keys";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
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

const { createChannelTransferMock, resolveGatewayAuthMock } = vi.hoisted(() => ({
  createChannelTransferMock: vi.fn(),
  resolveGatewayAuthMock: vi.fn(),
}));
const createProviderSigner = PrivySigner.create;
const createOrgSignerMock = vi.spyOn(PrivySigner, "create");
const providerFetch = vi.fn<typeof fetch>();
const originalPrivy = { appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET };

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

vi.mock("@/services/private-channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/private-channels")>();
  return { ...actual, createChannelTransfer: createChannelTransferMock };
});

vi.mock("@/services/private-channels/auth/gateway-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/private-channels/auth/gateway-auth")>();
  return { ...actual, resolveGatewayAuth: resolveGatewayAuthMock };
});

const ORGANIZATION_ID = "org_test_pc_transfers";
const PROJECT_ID = "prj_pc_transfers";
let CLERK_TOKEN: string;
const ACTOR_USER_ID = "usr_test_pc_transfer_actor";
const RECIPIENT_USER_ID = "usr_test_pc_transfer_recipient";
const OUTSIDER_USER_ID = "usr_test_pc_transfer_outsider";
const INSTANCE_ID = "pci_pc_transfers";
const CHANNEL_ID = "pch_pc_transfers";
const OTHER_CHANNEL_ID = "pch_pc_transfers_other";
const ACTOR_PC_USER_ID = "pcu_pc_transfer_actor";
const RECIPIENT_PC_USER_ID = "pcu_pc_transfer_recipient";
const OUTSIDER_PC_USER_ID = "pcu_pc_transfer_outsider";
const ACTOR_WALLET_ID = "wallet_pc_transfer_actor";
const UNVERIFIED_WALLET_ID = "wallet_pc_transfer_unverified";
const OTHER_USER_WALLET_ID = "wallet_pc_transfer_other_user";
const RECIPIENT_VERIFIED_WALLET_ID = "pcvw_pc_transfer_recipient";
const OTHER_USER_VERIFIED_WALLET_ID = "pcvw_pc_transfer_other_user";
const OUTSIDER_VERIFIED_WALLET_ID = "pcvw_pc_transfer_outsider";
const ACTOR_ADDRESS = "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz";
const RECIPIENT_ADDRESS = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
const OTHER_USER_ADDRESS = "So11111111111111111111111111111111111111112";
const OUTSIDER_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const UNVERIFIED_ADDRESS = "Vote111111111111111111111111111111111111111";
const ESCROW_PROGRAM_ID = "EscrowProgram11111111111111111111111111111";
const WITHDRAW_PROGRAM_ID = "WithdrawProgram111111111111111111111111111";
const ESCROW_INSTANCE_ADDRESS = "EscrowInstance111111111111111111111111111";
const API_KEY = {
  id: "key_pc_transfers",
  raw: "sk_test_private_channel_transfers",
  prefix: "sk_test_pct",
};

const SCOPED_API_KEY = {
  id: "key_pc_transfer_scoped",
  raw: "sk_test_private_channel_transfer_scoped",
  prefix: "sk_test_pcts",
};

const UNSAFE_RECIPIENTS = [
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
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
  const db = getDb(env);
  await insertTestStoredProviderCredential(db, {
    id: "pcred-pct",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    label: "PC",
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: ORGANIZATION_ID,
      credentialId: "pcred-pct",
      appId: "pc-transfer-connection-app",
      appSecret: "pc-transfer-connection-secret",
    }),
    displayMetadata: {},
    status: "active",
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: ACTOR_USER_ID,
  });
  await db
    .prepare("UPDATE custody_configs SET default_wallet_id = ? WHERE id = 'cust-pct'")
    .bind(OTHER_USER_WALLET_ID)
    .run();
  await insertTestCustodyConnection(db, {
    id: "conn-pct",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    credential: { id: "pcred-pct", projectId: PROJECT_ID },
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
    .prepare(
      "UPDATE custody_wallets SET custody_config_id = NULL, custody_connection_id = 'conn-pct' WHERE id = 'cw-pct-actor'"
    )
    .run();
  await activateTestCustodyConnection(db, {
    connectionId: "conn-pct",
    custodyWalletId: "cw-pct-actor",
    providerAccountFingerprint: "sha256:pc-transfer",
  });
}

async function keyTransfer(id: string, pending: boolean) {
  await seedTransfer({
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    channelId: CHANNEL_ID,
    id,
    status: pending ? "pending" : "submitted",
  });
  await getDb(env)
    .prepare(`UPDATE private_channel_transfers SET idempotency_key = ?, idempotency_fingerprint = ?,
    updated_at = ? WHERE id = ?`)
    .bind(
      "idem_route_transfer",
      buildPrivateChannelTransferFingerprint({
        instanceId: INSTANCE_ID,
        channelId: CHANNEL_ID,
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        mint: OUTSIDER_ADDRESS,
        amount: "1.5",
      }),
      new Date(Date.now() - 11 * 60_000).toISOString(),
      id
    )
    .run();
}

function humanHeaders(extra: Record<string, string>) {
  return {
    Authorization: `Bearer ${CLERK_TOKEN}`,
    "x-project-id": PROJECT_ID,
    "Content-Type": "application/json",
    ...extra,
  };
}

function apiKeyHeaders() {
  return {
    Authorization: `Bearer ${API_KEY.raw}`,
    "Content-Type": "application/json",
  };
}

function scopedApiKeyHeaders() {
  return { ...apiKeyHeaders(), Authorization: `Bearer ${SCOPED_API_KEY.raw}` };
}

function transferDto(overrides: Partial<PrivateChannelTransfer>): PrivateChannelTransfer {
  return {
    id: "pct_route_created",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    channelId: CHANNEL_ID,
    walletId: ACTOR_WALLET_ID,
    sender: ACTOR_ADDRESS,
    recipient: RECIPIENT_ADDRESS,
    mint: OUTSIDER_ADDRESS,
    amount: "1.5",
    status: "submitted",
    signature: "signature-route",
    failureReason: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
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
    walletBindings: [{ walletId: OTHER_USER_WALLET_ID, permissions: ["payments:write"] }],
  });

  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORGANIZATION_ID, "PC Transfer Org", "pc-transfer-org", "enterprise", "active"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status) VALUES
          (?, 'actor@example.com', 1, 'active'),
          (?, 'recipient@example.com', 1, 'active'),
          (?, 'outsider@example.com', 1, 'active')`
      )
      .bind(ACTOR_USER_ID, RECIPIENT_USER_ID, OUTSIDER_USER_ID),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ('om_pc_transfers', ?, ?, 'admin', 'active')`
      )
      .bind(ORGANIZATION_ID, ACTOR_USER_ID),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: ACTOR_USER_ID,
    members: [ACTOR_USER_ID],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await seedProjectApiKey(db, env, {
    key: TEST_PRODUCTION_API_KEY,
    organizationId: ORGANIZATION_ID,
    projectId: `${PROJECT_ID}_production`,
    createdBy: ACTOR_USER_ID,
    role: "api_admin",
    permissions: ["payments:read"],
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status)
         VALUES (?, ?, ?, ?, 'PC transfer key', ?, ?, 'api_admin', ?, 'active')`
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
         VALUES (?, ?, ?, 'https://gateway.example',
                 ?, ?, ?, 'https://auth.example', true)`
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
      VALUES ('akwp-pct', ?, ?, ?)`)
      .bind(SCOPED_API_KEY.id, OTHER_USER_WALLET_ID, JSON.stringify(["payments:write"])),
    db
      .prepare(
        `INSERT INTO private_channels
           (id, organization_id, project_id, instance_id, name, is_default)
         VALUES
           (?, ?, ?, ?, 'Treasury', false),
           (?, ?, ?, ?, 'Operations', false)`
      )
      .bind(
        CHANNEL_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        INSTANCE_ID,
        OTHER_CHANNEL_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        INSTANCE_ID
      ),
    db
      .prepare(
        `INSERT INTO private_channel_users
           (id, organization_id, project_id, user_id, instance_id, name, is_default,
            spc_user_id, spc_username, spc_credential_ciphertext)
         VALUES
           (?, ?, ?, ?, ?, 'Default', true, 'spc-actor', 'actor', 'cipher-actor'),
           (?, ?, ?, ?, ?, 'Recipient', false, 'spc-recipient', 'recipient', 'cipher-recipient'),
           (?, ?, ?, ?, ?, 'Outsider', false, 'spc-outsider', 'outsider', 'cipher-outsider')`
      )
      .bind(
        ACTOR_PC_USER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_USER_ID,
        INSTANCE_ID,
        RECIPIENT_PC_USER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        RECIPIENT_USER_ID,
        INSTANCE_ID,
        OUTSIDER_PC_USER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        OUTSIDER_USER_ID,
        INSTANCE_ID
      ),
    db
      .prepare(
        `INSERT INTO private_channel_memberships
           (id, channel_id, private_channel_user_id, added_by)
         VALUES
           ('pcm-pct-actor', ?, ?, ?),
           ('pcm-pct-recipient', ?, ?, ?)`
      )
      .bind(
        CHANNEL_ID,
        ACTOR_PC_USER_ID,
        ACTOR_USER_ID,
        CHANNEL_ID,
        RECIPIENT_PC_USER_ID,
        ACTOR_USER_ID
      ),
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, default_wallet_id, status)
         VALUES ('cust-pct', ?, ?, 'privy', '{}', ?, 'active')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, ACTOR_WALLET_ID),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES ('csd-pct', ?, ?, 'cust-pct')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES
           ('cw-pct-actor', 'cust-pct', ?, ?, 'Actor', 'transfer', 'active'),
           ('cw-pct-unverified', 'cust-pct', ?, ?, 'Unverified', 'transfer', 'active'),
           ('cw-pct-other', 'cust-pct', ?, ?, 'Other user', 'transfer', 'active')`
      )
      .bind(
        ACTOR_WALLET_ID,
        ACTOR_ADDRESS,
        UNVERIFIED_WALLET_ID,
        UNVERIFIED_ADDRESS,
        OTHER_USER_WALLET_ID,
        OTHER_USER_ADDRESS
      ),
    db
      .prepare(
        `INSERT INTO private_channel_verified_wallets
           (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey)
         VALUES
           ('pcvw-pct-actor', ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_PC_USER_ID,
        INSTANCE_ID,
        ACTOR_WALLET_ID,
        ACTOR_ADDRESS,
        RECIPIENT_VERIFIED_WALLET_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        RECIPIENT_PC_USER_ID,
        INSTANCE_ID,
        "wallet-recipient",
        RECIPIENT_ADDRESS,
        OTHER_USER_VERIFIED_WALLET_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        RECIPIENT_PC_USER_ID,
        INSTANCE_ID,
        OTHER_USER_WALLET_ID,
        OTHER_USER_ADDRESS,
        OUTSIDER_VERIFIED_WALLET_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        OUTSIDER_PC_USER_ID,
        INSTANCE_ID,
        "wallet-outsider",
        OUTSIDER_ADDRESS
      ),
  ]);
}

async function seedTransfer(input: {
  id: string;
  projectId: string;
  instanceId: string;
  channelId: string;
  status: "pending" | "submitted" | "failed";
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO private_channel_transfers (
         id, organization_id, project_id, instance_id, channel_id,
         sender_private_channel_user_id, recipient_private_channel_user_id,
         sender_wallet_id, recipient_verified_wallet_id, sender, recipient,
         mint, amount, status, signature
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.5', ?, ?)`
    )
    .bind(
      input.id,
      ORGANIZATION_ID,
      input.projectId,
      input.instanceId,
      input.channelId,
      ACTOR_PC_USER_ID,
      RECIPIENT_PC_USER_ID,
      ACTOR_WALLET_ID,
      RECIPIENT_VERIFIED_WALLET_ID,
      ACTOR_ADDRESS,
      RECIPIENT_ADDRESS,
      OUTSIDER_ADDRESS,
      input.status,
      input.status === "pending" ? null : "sig-read"
    )
    .run();
}

async function postTransfer(body: Record<string, unknown>, headers: Record<string, string>) {
  return app.request(
    `/v1/private-channels/channels/${CHANNEL_ID}/transfers`,
    { method: "POST", headers, body: JSON.stringify(body) },
    env
  );
}

describe("Private Channels — transfer access and routes", () => {
  afterAll(() => {
    createOrgSignerMock.mockRestore();
    env.PRIVY_APP_ID = originalPrivy.appId;
    env.PRIVY_APP_SECRET = originalPrivy.appSecret;
  });

  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    env.PRIVY_APP_ID = "pc-transfer-app";
    env.PRIVY_APP_SECRET = "pc-transfer-secret";
    await seedTestDatabase(env);
    await seedRouteState();
    CLERK_TOKEN = await signSeededClerkMember(env, getDb(env), ACTOR_USER_ID, ORGANIZATION_ID);
    await verifyClerkJwt(CLERK_TOKEN, env);
    createChannelTransferMock.mockReset();
    resolveGatewayAuthMock.mockReset();
    createOrgSignerMock.mockReset();
    createChannelTransferMock.mockResolvedValue(transferDto({}));
    createOrgSignerMock.mockImplementation(createProviderSigner);
    providerFetch
      .mockReset()
      .mockImplementation(async () =>
        Response.json({ address: ACTOR_ADDRESS, chain_type: "solana", id: ACTOR_WALLET_ID })
      );
    vi.stubGlobal("fetch", providerFetch);
    resolveGatewayAuthMock.mockResolvedValue({
      current: "jwt-route",
      pcUserId: ACTOR_PC_USER_ID,
      refresh: vi.fn(),
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
    await clearKVStores(env);
  });

  it.each([false, true])(
    "uses role permissions for transfer execution and replay (replay=%s)",
    async (replay) => {
      if (replay) await keyTransfer("pct_role_replay", false);
      await getDb(env)
        .prepare("UPDATE api_keys SET permissions = NULL WHERE id = ?")
        .bind(API_KEY.id)
        .run();
      await clearKVStores(env);

      const response = await postTransfer(
        {
          walletId: ACTOR_WALLET_ID,
          recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
          amount: "1.5",
        },
        { ...apiKeyHeaders(), "Idempotency-Key": "idem_route_transfer" }
      );

      expect(response.status).toBe(200);
      if (replay) {
        expect(await response.json()).toMatchObject({ data: { id: "pct_role_replay" } });
        expect(createOrgSignerMock).not.toHaveBeenCalled();
      }
    }
  );

  it("requires the original source for transfer replay while history remains readable", async () => {
    await seedTransfer({
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: CHANNEL_ID,
      status: "submitted",
      id: "pct_replay",
    });
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `UPDATE private_channel_transfers SET idempotency_key = ?, idempotency_fingerprint = ? WHERE id = 'pct_replay'`
        )
        .bind(
          "idem_route_transfer",
          buildPrivateChannelTransferFingerprint({
            instanceId: INSTANCE_ID,
            channelId: CHANNEL_ID,
            walletId: ACTOR_WALLET_ID,
            recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
            mint: OUTSIDER_ADDRESS,
            amount: "1.5",
          })
        ),
      getDb(env).prepare(
        "UPDATE custody_wallets SET status = 'inactive' WHERE id = 'cw-pct-actor'"
      ),
    ]);
    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.500",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );
    expect(response.status).toBe(404);
    const history = await app.request(
      "/v1/private-channels/transfers/pct_replay",
      { headers: humanHeaders({}) },
      env
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      data: { id: "pct_replay", status: "submitted" },
    });
    expect(createOrgSignerMock).not.toHaveBeenCalled();
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
  });

  it("admits an explicitly chosen nondefault Connection before transfer setup", async () => {
    await useConnectionSource();
    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );
    expect(response.status).toBe(200);
    expect(createOrgSignerMock).toHaveBeenCalledOnce();
    expect(createOrgSignerMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "pc-transfer-connection-app" })
    );
    expect(resolveGatewayAuthMock).toHaveBeenCalledOnce();
  });

  it("refuses an explicitly chosen nondefault Connection before transfer setup while BYOK is out of channel", async () => {
    await useConnectionSource();
    custodyReleaseChannel.outOfChannelMode = "byok";
    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer_out_of_channel" })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: custodyProviderNotInReleaseChannel("privy", "byok").message,
        details: { reason: "custody_provider_not_in_release_channel" },
      },
      meta: { requestId: expect.any(String) },
    });
    expect(createOrgSignerMock).not.toHaveBeenCalled();
    expect(resolveGatewayAuthMock).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires write for abandoned transfer recovery without a signer (write=%s)",
    async (write) => {
      await keyTransfer("pct_abandoned", true);
      await useConnectionSource();
      custodyReleaseChannel.outOfChannelMode = "byok";
      await getDb(env)
        .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
        .bind(
          JSON.stringify(write ? ["payments:read", "payments:write"] : ["payments:read"]),
          API_KEY.id
        )
        .run();
      const response = await postTransfer(
        {
          walletId: ACTOR_WALLET_ID,
          recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
          amount: "1.5",
        },
        { ...apiKeyHeaders(), "Idempotency-Key": "idem_route_transfer" }
      );
      expect(response.status).toBe(write ? 200 : 403);
      const history = await app.request(
        "/v1/private-channels/transfers/pct_abandoned",
        { headers: apiKeyHeaders() },
        env
      );
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({
        data: { id: "pct_abandoned", status: write ? "failed" : "pending" },
      });
      expect(createOrgSignerMock).not.toHaveBeenCalled();
      expect(resolveGatewayAuthMock).toHaveBeenCalledTimes(write ? 1 : 0);
    }
  );

  it.each(['["payments:write"]', '["payments:read", "payments:write"]'])(
    "rechecks the winner's original source after losing an idempotency reservation (%s)",
    async (permissions) => {
      await getDb(env)
        .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
        .bind(permissions, API_KEY.id)
        .run();
      createChannelTransferMock.mockImplementationOnce(async (_env, input) => {
        await keyTransfer("pct_race_winner", false);
        await getDb(env)
          .prepare("UPDATE private_channel_transfers SET sender = ? WHERE id = 'pct_race_winner'")
          .bind(OTHER_USER_ADDRESS)
          .run();
        const winner = await createPrivateChannelTransferRepository(env).getTransferById({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          id: "pct_race_winner",
        });
        return input.onReplay(winner);
      });
      const response = await postTransfer(
        {
          walletId: ACTOR_WALLET_ID,
          recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
          amount: "1.5",
        },
        { ...apiKeyHeaders(), "Idempotency-Key": "idem_route_transfer" }
      );
      expect(response.status).toBe(409);

      expect(createOrgSignerMock).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps the selected source when the default changes during signer preparation", async () => {
    createOrgSignerMock.mockImplementationOnce(async (config) => {
      await getDb(env)
        .prepare("UPDATE custody_configs SET default_wallet_id = ? WHERE id = 'cust-pct'")
        .bind(OTHER_USER_WALLET_ID)
        .run();
      return createProviderSigner(config);
    });
    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );
    expect(response.status).toBe(200);
    expect(createOrgSignerMock).toHaveBeenCalledTimes(1);
    expect(createOrgSignerMock).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: ACTOR_WALLET_ID })
    );
  });

  it("allows API keys to use the project's default identity", async () => {
    const recipients = await app.request(
      `/v1/private-channels/channels/${CHANNEL_ID}/transfer-recipients`,
      { headers: apiKeyHeaders() },
      env
    );
    expect(recipients.status).toBe(200);

    const transfer = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      { ...apiKeyHeaders(), "Idempotency-Key": "idem_route_transfer" }
    );
    expect(transfer.status).toBe(200);
    expect(createChannelTransferMock).toHaveBeenCalledOnce();
  });

  it("refuses to move funds without an idempotency key", async () => {
    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({})
    );

    expect(response.status).toBe(400);

    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("lists one entry per verified wallet in the active channel, the caller's own first", async () => {
    const response = await app.request(
      `/v1/private-channels/channels/${CHANNEL_ID}/transfer-recipients`,
      { headers: humanHeaders({}) },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        recipients: Array<{
          id: string;
          pubkey: string;
          privateChannelUserId: string;
          isSelf: boolean;
        }>;
      };
    };
    expect(body.data.recipients).toEqual([
      expect.objectContaining({
        id: "pcvw-pct-actor",
        pubkey: ACTOR_ADDRESS,
        privateChannelUserId: ACTOR_PC_USER_ID,
        isSelf: true,
      }),
      expect.objectContaining({
        id: RECIPIENT_VERIFIED_WALLET_ID,
        pubkey: RECIPIENT_ADDRESS,
        privateChannelUserId: RECIPIENT_PC_USER_ID,
        isSelf: false,
      }),
      expect.objectContaining({
        id: OTHER_USER_VERIFIED_WALLET_ID,
        pubkey: OTHER_USER_ADDRESS,
        privateChannelUserId: RECIPIENT_PC_USER_ID,
        isSelf: false,
      }),
    ]);
  });

  it("denies a project admin without explicit channel membership", async () => {
    await getDb(env)
      .prepare(
        "DELETE FROM private_channel_memberships WHERE private_channel_user_id = ? AND channel_id = ?"
      )
      .bind(ACTOR_PC_USER_ID, CHANNEL_ID)
      .run();

    const recipients = await app.request(
      `/v1/private-channels/channels/${CHANNEL_ID}/transfer-recipients`,
      { headers: humanHeaders({}) },
      env
    );
    expect(recipients.status).toBe(403);

    const transfer = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );
    expect(transfer.status).toBe(403);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it.each(["1.2.3", "0.0000001"])(
    "rejects malformed or over-precise amount %s at the route boundary",
    async (amount) => {
      const response = await postTransfer(
        {
          walletId: ACTOR_WALLET_ID,
          recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
          amount,
        },
        humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
      );

      expect(response.status).toBe(400);
      expect(createChannelTransferMock).not.toHaveBeenCalled();
    }
  );

  it("refuses a selected-scope API key naming an enrolled wallet it is not bound to", async () => {
    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      { ...scopedApiKeyHeaders(), "Idempotency-Key": "idem_route_transfer_scoped" }
    );

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain(
      "not authorized for the requested wallet"
    );
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("requires the source custody wallet to be enrolled under the principal", async () => {
    const response = await postTransfer(
      {
        walletId: UNVERIFIED_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );

    expect(response.status).toBe(403);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("does not let the sender use another member's verified custody wallet", async () => {
    const response = await postTransfer(
      {
        walletId: OTHER_USER_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );

    expect(response.status).toBe(403);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("rejects an active custody wallet whose provider cannot produce a signer", async () => {
    createOrgSignerMock.mockRejectedValueOnce(new Error("custody provider unavailable"));

    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );

    expect(response.status).toBe(503);
    expect(createOrgSignerMock).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: ACTOR_WALLET_ID })
    );
    expect(createChannelTransferMock).not.toHaveBeenCalled();
    const persisted = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM private_channel_transfers")
      .first<{ count: number }>();
    expect(required(persisted).count).toBe(0);
  });

  it("rejects a signer whose address does not match the verified source wallet", async () => {
    providerFetch.mockImplementationOnce(async () =>
      Response.json({ address: RECIPIENT_ADDRESS, chain_type: "solana", id: ACTOR_WALLET_ID })
    );

    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );

    expect(response.status).toBe(409);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
    const persisted = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM private_channel_transfers")
      .first<{ count: number }>();
    expect(required(persisted).count).toBe(0);
  });

  it("accepts only opaque verified-wallet ids from eligible same-channel recipients", async () => {
    const outsider = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: OUTSIDER_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );
    expect(outsider.status).toBe(404);
    expect((await outsider.json()) as object).toMatchObject({
      error: { message: expect.stringContaining("Eligible transfer recipient") },
    });

    const arbitraryAddress = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_ADDRESS,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );
    expect(arbitraryAddress.status).toBe(404);
    expect((await arbitraryAddress.json()) as object).toMatchObject({
      error: { message: expect.stringContaining("Eligible transfer recipient") },
    });
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("rejects a recipient wallet whose pubkey equals the sender", async () => {
    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: "pcvw-pct-actor",
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );
    expect(response.status).toBe(400);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("allows a transfer between two verified wallets owned by the same member", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO private_channel_verified_wallets
           (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey)
         VALUES ('pcvw-pct-actor-second', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_PC_USER_ID,
        INSTANCE_ID,
        UNVERIFIED_WALLET_ID,
        UNVERIFIED_ADDRESS
      )
      .run();

    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: "pcvw-pct-actor-second",
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );

    expect(response.status).toBe(200);
    expect(createChannelTransferMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipient: {
          privateChannelUserId: ACTOR_PC_USER_ID,
          verifiedWalletId: "pcvw-pct-actor-second",
          pubkey: UNVERIFIED_ADDRESS,
        },
      })
    );
  });

  it.each(UNSAFE_RECIPIENTS)("rejects the known unsafe %s address", async (_name, pubkey) => {
    const id = `pcvw-pct-unsafe-${_name.replaceAll(" ", "-")}`;
    await getDb(env)
      .prepare(
        `INSERT INTO private_channel_verified_wallets
           (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        ORGANIZATION_ID,
        PROJECT_ID,
        RECIPIENT_PC_USER_ID,
        INSTANCE_ID,
        `wallet-${id}`,
        pubkey
      )
      .run();

    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: id,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );
    expect(response.status).toBe(400);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("creates a transfer with the resolved actor, custody wallet, recipient, instance, and auth", async () => {
    const response = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      humanHeaders({ "Idempotency-Key": "idem_route_transfer" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: "pct_route_created" } });
    expect(resolveGatewayAuthMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        userId: ACTOR_USER_ID,
      })
    );
    expect(createChannelTransferMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        channelId: CHANNEL_ID,
        sdpUserId: ACTOR_USER_ID,
        wallet: expect.objectContaining({
          walletId: ACTOR_WALLET_ID,
          publicKey: ACTOR_ADDRESS,
        }),
        recipient: {
          privateChannelUserId: RECIPIENT_PC_USER_ID,
          verifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
          pubkey: RECIPIENT_ADDRESS,
        },
        amount: "1.5",

        idempotencyKey: "idem_route_transfer",
        gatewayAuth: expect.objectContaining({ pcUserId: ACTOR_PC_USER_ID }),
      })
    );
  });

  it("supports transfer reads and an optional channel filter", async () => {
    await seedTransfer({
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: CHANNEL_ID,
      status: "submitted",
      id: "pct-visible-a",
    });
    await seedTransfer({
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      status: "submitted",
      id: "pct-visible-b",
      channelId: OTHER_CHANNEL_ID,
    });

    const list = await app.request(
      "/v1/private-channels/transfers",
      {
        headers: humanHeaders({}),
      },
      env
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { transfers: PrivateChannelTransfer[] } };
    expect(listBody.data.transfers.map((transfer) => transfer.id).sort()).toEqual([
      "pct-visible-a",
      "pct-visible-b",
    ]);

    const filtered = await app.request(
      `/v1/private-channels/transfers?channelId=${CHANNEL_ID}`,
      { headers: humanHeaders({}) },
      env
    );
    const filteredBody = (await filtered.json()) as {
      data: { transfers: PrivateChannelTransfer[] };
    };
    expect(filtered.status).toBe(200);
    expect(filteredBody.data.transfers.map((transfer) => transfer.id)).toEqual(["pct-visible-a"]);

    const getVisible = await app.request(
      "/v1/private-channels/transfers/pct-visible-a",
      {
        headers: humanHeaders({}),
      },
      env
    );
    expect(getVisible.status).toBe(200);
  });

  it("returns 404 for another project's transfer", async () => {
    await seedTransfer({
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: CHANNEL_ID,
      status: "submitted",
      id: "pct-sandbox-owned",
    });
    const response = await app.request(
      "/v1/private-channels/transfers/pct-sandbox-owned",
      {
        headers: { Authorization: `Bearer ${TEST_PRODUCTION_API_KEY.raw}` },
      },
      env
    );
    expect(response.status).toBe(404);
  });
});
