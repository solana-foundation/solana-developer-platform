import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, PrivateChannelTransfer } from "@sdp/types";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as solanaServices from "@/services/solana";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const { createChannelTransferMock, resolveGatewayAuthMock } = vi.hoisted(() => ({
  createChannelTransferMock: vi.fn(),
  resolveGatewayAuthMock: vi.fn(),
}));
const createOrgSignerMock = vi.spyOn(solanaServices, "createOrgSigner");

vi.mock("@/services/private-channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/private-channels")>();
  return { ...actual, createChannelTransfer: createChannelTransferMock };
});

vi.mock("@/services/private-channels/auth/gateway-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/private-channels/auth/gateway-auth")>();
  return { ...actual, resolveGatewayAuth: resolveGatewayAuthMock };
});

const ORGANIZATION_ID = "org_pc_transfers";
const PROJECT_ID = "prj_pc_transfers";
const OTHER_PROJECT_ID = "prj_pc_transfers_other";
const SESSION_ID = "ses_pc_transfers";
const ACTOR_USER_ID = "usr_pc_transfer_actor";
const RECIPIENT_USER_ID = "usr_pc_transfer_recipient";
const OUTSIDER_USER_ID = "usr_pc_transfer_outsider";
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

function sessionHeaders(extra: Record<string, string> = {}) {
  return {
    Cookie: `sdp_session=${SESSION_ID}`,
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

function transferDto(overrides: Partial<PrivateChannelTransfer> = {}): PrivateChannelTransfer {
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
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(
        SESSION_ID,
        ACTOR_USER_ID,
        ORGANIZATION_ID,
        new Date(Date.now() + 60_000).toISOString()
      ),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES
           (?, ?, 'Transfer Project', 'pc-transfer-project', 'sandbox', 'active', ?),
           (?, ?, 'Other Project', 'pc-transfer-other', 'sandbox', 'active', ?)`
      )
      .bind(
        PROJECT_ID,
        ORGANIZATION_ID,
        ACTOR_USER_ID,
        OTHER_PROJECT_ID,
        ORGANIZATION_ID,
        ACTOR_USER_ID
      ),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES ('pm_pc_transfers', ?, ?, 'admin')`
      )
      .bind(PROJECT_ID, ACTOR_USER_ID),
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
           (id, organization_id, project_id, gateway_url, chain_rpc_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
         VALUES (?, ?, ?, 'https://gateway.example', 'https://api.devnet.solana.com',
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
           (id, organization_id, project_id, user_id, spc_user_id, spc_username,
            spc_credential_ciphertext)
         VALUES
           (?, ?, ?, ?, 'spc-actor', 'actor', 'cipher-actor'),
           (?, ?, ?, ?, 'spc-recipient', 'recipient', 'cipher-recipient'),
           (?, ?, ?, ?, 'spc-outsider', 'outsider', 'cipher-outsider')`
      )
      .bind(
        ACTOR_PC_USER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_USER_ID,
        RECIPIENT_PC_USER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        RECIPIENT_USER_ID,
        OUTSIDER_PC_USER_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        OUTSIDER_USER_ID
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
         VALUES ('cust-pct', ?, ?, 'turnkey', '{}', ?, 'active')`
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
  projectId?: string;
  instanceId?: string;
  channelId?: string;
  status?: "pending" | "submitted" | "failed";
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO private_channel_transfers (
         id, organization_id, project_id, instance_id, channel_id,
         sender_private_channel_user_id, recipient_private_channel_user_id,
         sender_wallet_id, recipient_verified_wallet_id, sender, recipient,
         mint, amount, status, signature
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.5', ?, 'sig-read')`
    )
    .bind(
      input.id,
      ORGANIZATION_ID,
      input.projectId ?? PROJECT_ID,
      input.instanceId ?? INSTANCE_ID,
      input.channelId ?? CHANNEL_ID,
      ACTOR_PC_USER_ID,
      RECIPIENT_PC_USER_ID,
      ACTOR_WALLET_ID,
      RECIPIENT_VERIFIED_WALLET_ID,
      ACTOR_ADDRESS,
      RECIPIENT_ADDRESS,
      OUTSIDER_ADDRESS,
      input.status ?? "submitted"
    )
    .run();
}

async function postTransfer(
  body: Record<string, unknown>,
  headers: Record<string, string> = sessionHeaders()
) {
  return app.request(
    `/v1/private-channels/channels/${CHANNEL_ID}/transfers`,
    { method: "POST", headers, body: JSON.stringify(body) },
    env
  );
}

describe("Private Channels — transfer access and routes", () => {
  afterAll(() => {
    createOrgSignerMock.mockRestore();
  });

  beforeEach(async () => {
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedRouteState();
    createChannelTransferMock.mockReset();
    resolveGatewayAuthMock.mockReset();
    createOrgSignerMock.mockReset();
    createChannelTransferMock.mockResolvedValue(transferDto());
    createOrgSignerMock.mockResolvedValue({ address: ACTOR_ADDRESS } as never);
    resolveGatewayAuthMock.mockResolvedValue({
      current: "jwt-route",
      pcUserId: ACTOR_PC_USER_ID,
      refresh: vi.fn(),
    });
  });

  afterEach(async () => {
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("requires a real user identity for recipient discovery and transfer creation", async () => {
    const recipients = await app.request(
      `/v1/private-channels/channels/${CHANNEL_ID}/transfer-recipients`,
      { headers: apiKeyHeaders() },
      env
    );
    expect(recipients.status).toBe(403);

    const transfer = await postTransfer(
      {
        walletId: ACTOR_WALLET_ID,
        recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
        amount: "1.5",
      },
      apiKeyHeaders()
    );
    expect(transfer.status).toBe(403);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("lists verified wallets of other members in the active channel only", async () => {
    const response = await app.request(
      `/v1/private-channels/channels/${CHANNEL_ID}/transfer-recipients`,
      { headers: sessionHeaders() },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        recipients: Array<{
          privateChannelUserId: string;
          wallets: Array<{ id: string; pubkey: string }>;
        }>;
      };
    };
    expect(body.data.recipients).toEqual([
      expect.objectContaining({
        privateChannelUserId: RECIPIENT_PC_USER_ID,
        wallets: [
          { id: RECIPIENT_VERIFIED_WALLET_ID, pubkey: RECIPIENT_ADDRESS },
          { id: OTHER_USER_VERIFIED_WALLET_ID, pubkey: OTHER_USER_ADDRESS },
        ],
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
      { headers: sessionHeaders() },
      env
    );
    expect(recipients.status).toBe(403);

    const transfer = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      amount: "1.5",
    });
    expect(transfer.status).toBe(403);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it.each([
    "1.2.3",
    "0.0000001",
  ])("rejects malformed or over-precise amount %s at the route boundary", async (amount) => {
    const response = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      amount,
    });

    expect(response.status).toBe(400);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("requires the source custody wallet to be verified by the acting member", async () => {
    const response = await postTransfer({
      walletId: UNVERIFIED_WALLET_ID,
      recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      amount: "1.5",
    });

    expect(response.status).toBe(403);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("does not let the sender use another member's verified custody wallet", async () => {
    const response = await postTransfer({
      walletId: OTHER_USER_WALLET_ID,
      recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      amount: "1.5",
    });

    expect(response.status).toBe(403);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("rejects an active custody wallet whose provider cannot produce a signer", async () => {
    createOrgSignerMock.mockRejectedValueOnce(new Error("custody provider unavailable"));

    const response = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      amount: "1.5",
    });

    expect(response.status).toBe(503);
    expect(createOrgSignerMock).toHaveBeenCalledWith(
      expect.anything(),
      ORGANIZATION_ID,
      PROJECT_ID,
      ACTOR_WALLET_ID
    );
    expect(createChannelTransferMock).not.toHaveBeenCalled();
    const persisted = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM private_channel_transfers")
      .first<{ count: number }>();
    expect(persisted?.count).toBe(0);
  });

  it("rejects a signer whose address does not match the verified source wallet", async () => {
    createOrgSignerMock.mockResolvedValueOnce({ address: RECIPIENT_ADDRESS } as never);

    const response = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      amount: "1.5",
    });

    expect(response.status).toBe(400);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
    const persisted = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM private_channel_transfers")
      .first<{ count: number }>();
    expect(persisted?.count).toBe(0);
  });

  it("accepts only opaque verified-wallet ids from eligible same-channel recipients", async () => {
    const outsider = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: OUTSIDER_VERIFIED_WALLET_ID,
      amount: "1.5",
    });
    expect(outsider.status).toBe(404);
    expect((await outsider.json()) as object).toMatchObject({
      error: { message: expect.stringContaining("Eligible transfer recipient") },
    });

    const arbitraryAddress = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: RECIPIENT_ADDRESS,
      amount: "1.5",
    });
    expect(arbitraryAddress.status).toBe(404);
    expect((await arbitraryAddress.json()) as object).toMatchObject({
      error: { message: expect.stringContaining("Eligible transfer recipient") },
    });
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("rejects a recipient wallet whose pubkey equals the sender", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO private_channel_verified_wallets
           (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey)
         VALUES ('pcvw-pct-self', ?, ?, ?, ?, 'wallet-self', ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, RECIPIENT_PC_USER_ID, INSTANCE_ID, ACTOR_ADDRESS)
      .run();

    const response = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: "pcvw-pct-self",
      amount: "1.5",
    });
    expect(response.status).toBe(400);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
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

    const response = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: id,
      amount: "1.5",
    });
    expect(response.status).toBe(400);
    expect(createChannelTransferMock).not.toHaveBeenCalled();
  });

  it("creates a transfer with the resolved actor, custody wallet, recipient, instance, and auth", async () => {
    const response = await postTransfer({
      walletId: ACTOR_WALLET_ID,
      recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      amount: "1.5",
    });

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
        gatewayAuth: expect.objectContaining({ pcUserId: ACTOR_PC_USER_ID }),
      })
    );
  });

  it("keeps transfer reads project scoped and supports an optional channel filter", async () => {
    await seedTransfer({ id: "pct-visible-a" });
    await seedTransfer({ id: "pct-visible-b", channelId: OTHER_CHANNEL_ID });
    await seedTransfer({
      id: "pct-other-project",
      projectId: OTHER_PROJECT_ID,
      instanceId: "pci-other",
      channelId: "pch-other",
    });

    const list = await app.request(
      "/v1/private-channels/transfers",
      {
        headers: sessionHeaders(),
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
      { headers: sessionHeaders() },
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
        headers: sessionHeaders(),
      },
      env
    );
    expect(getVisible.status).toBe(200);

    const getOtherProject = await app.request(
      "/v1/private-channels/transfers/pct-other-project",
      { headers: sessionHeaders() },
      env
    );
    expect(getOtherProject.status).toBe(404);
  });
});
