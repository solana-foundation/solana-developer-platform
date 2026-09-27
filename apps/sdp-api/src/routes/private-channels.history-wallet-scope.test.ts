/**
 * Wallet-scope isolation for the Private Channels movement-history reads
 * (SOLA9-518 / APE-765).
 *
 * A selected-scope API key bound to one wallet, holding global
 * `payments:read`, used to list and fetch the project's deposit, withdrawal
 * and transfer history for EVERY wallet in the project: the GET routes
 * applied only project-level filters, so the key could enumerate other
 * wallets' counterparties, amounts, statuses and signatures. The reads now
 * resolve the caller's allowed wallet ids for `payments:read` and enforce
 * them in SQL — deposits and withdrawals by `wallet_id`, transfers by
 * `sender_wallet_id` — with an empty selected scope matching no rows.
 *
 * Sessions and all-wallet keys keep full project visibility; the
 * other-project 404 control still holds.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  createPrivateChannelDepositRepository,
  createPrivateChannelWithdrawalRepository,
} from "@/db/repositories";
import app from "@/index";
import { buildPrivateChannelDepositFingerprint } from "@/lib/idempotency";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const ORGANIZATION_ID = "org_pc_histscope";
const PROJECT_ID = "prj_pc_histscope";
const OTHER_PROJECT_ID = `${PROJECT_ID}_production`;
const SESSION_ID = "ses_pc_histscope";
const ACTOR_USER_ID = "usr_pc_histscope_actor";
const RECIPIENT_USER_ID = "usr_pc_histscope_recipient";
const INSTANCE_ID = "pci_pc_histscope";
const CHANNEL_ID = "pch_pc_histscope";
const ACTOR_PC_USER_ID = "pcu_pc_histscope_actor";
const RECIPIENT_PC_USER_ID = "pcu_pc_histscope_recipient";
/** The wallet the scoped key is bound to. */
const BOUND_WALLET_ID = "wallet_pc_histscope_bound";
/** Another project custody wallet the scoped key is NOT bound to. */
const OTHER_WALLET_ID = "wallet_pc_histscope_other";
const BOUND_ADDRESS = "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz";
const OTHER_ADDRESS = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
const RECIPIENT_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MINT_ADDRESS = "So11111111111111111111111111111111111111112";
const ESCROW_PROGRAM_ID = "EscrowProgram11111111111111111111111111111";
const WITHDRAW_PROGRAM_ID = "WithdrawProgram111111111111111111111111111";
const ESCROW_INSTANCE_ADDRESS = "EscrowInstance111111111111111111111111111";

/** Selected-scope key bound to one wallet, global payments:read (the POC key). */
const SCOPED_API_KEY = {
  id: "key_pc_histscope_scoped",
  raw: "sk_test_pc_histscope_scoped",
  prefix: "sk_test_pchs",
};
/** All-wallet key: must keep seeing the whole project's history. */
const ALL_API_KEY = {
  id: "key_pc_histscope_all",
  raw: "sk_test_pc_histscope_all",
  prefix: "sk_test_pcha",
};
/** Selected-scope key whose only binding lacks payments:read. */
const NO_READ_BINDING_API_KEY = {
  id: "key_pc_histscope_noread",
  raw: "sk_test_pc_histscope_noread",
  prefix: "sk_test_pchn",
};

let originalPrivateChannelsEnabled: string | undefined;

function sessionHeaders(extra: Record<string, string> = {}) {
  return {
    Cookie: `sdp_session=${SESSION_ID}`,
    "x-project-id": PROJECT_ID,
    "Content-Type": "application/json",
    ...extra,
  };
}

function keyHeaders(key: { raw: string }) {
  return {
    Authorization: `Bearer ${key.raw}`,
    "Content-Type": "application/json",
  };
}

async function seedRouteState(): Promise<void> {
  const db = getDb(env);
  const permissions = JSON.stringify(["payments:read"]);

  await seedCachedApiKey(env, await hashString(SCOPED_API_KEY.raw, env.API_KEY_PEPPER), {
    id: SCOPED_API_KEY.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    role: "api_admin",
    permissions: ["payments:read"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
    walletScope: "selected",
    walletBindings: [{ walletId: BOUND_WALLET_ID, permissions: ["payments:read"] }],
  } satisfies CachedApiKey);
  await seedCachedApiKey(env, await hashString(ALL_API_KEY.raw, env.API_KEY_PEPPER), {
    id: ALL_API_KEY.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    role: "api_admin",
    permissions: ["payments:read"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
    walletScope: "all",
  } satisfies CachedApiKey);
  await seedCachedApiKey(env, await hashString(NO_READ_BINDING_API_KEY.raw, env.API_KEY_PEPPER), {
    id: NO_READ_BINDING_API_KEY.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    role: "api_admin",
    permissions: ["payments:read"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
    walletScope: "selected",
    walletBindings: [{ walletId: BOUND_WALLET_ID, permissions: ["payments:write"] }],
  } satisfies CachedApiKey);

  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORGANIZATION_ID, "PC History Org", "pc-history-org", "enterprise", "active"),
    db
      .prepare(`INSERT INTO users (id, email, email_verified, status) VALUES
        (?, 'history-actor@example.com', 1, 'active'),
        (?, 'history-recipient@example.com', 1, 'active')`)
      .bind(ACTOR_USER_ID, RECIPIENT_USER_ID),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ('om_pc_histscope', ?, ?, 'admin', 'active')`
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
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: ACTOR_USER_ID,
    members: [ACTOR_USER_ID],
    ids: { sandbox: PROJECT_ID, production: OTHER_PROJECT_ID },
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status)
         VALUES
           (?, ?, ?, ?, 'PC history scoped', ?, ?, 'api_admin', ?, 'active'),
           (?, ?, ?, ?, 'PC history all', ?, ?, 'api_admin', ?, 'active'),
           (?, ?, ?, ?, 'PC history noread', ?, ?, 'api_admin', ?, 'active')`
      )
      .bind(
        SCOPED_API_KEY.id,
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_USER_ID,
        SCOPED_API_KEY.prefix,
        await hashString(SCOPED_API_KEY.raw, env.API_KEY_PEPPER),
        permissions,
        ALL_API_KEY.id,
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_USER_ID,
        ALL_API_KEY.prefix,
        await hashString(ALL_API_KEY.raw, env.API_KEY_PEPPER),
        permissions,
        NO_READ_BINDING_API_KEY.id,
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_USER_ID,
        NO_READ_BINDING_API_KEY.prefix,
        await hashString(NO_READ_BINDING_API_KEY.raw, env.API_KEY_PEPPER),
        permissions
      ),
    db
      .prepare(`INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
      VALUES
        ('akwp-hs-scoped', ?, ?, ?),
        ('akwp-hs-noread', ?, ?, ?)`)
      .bind(
        SCOPED_API_KEY.id,
        BOUND_WALLET_ID,
        JSON.stringify(["payments:read"]),
        NO_READ_BINDING_API_KEY.id,
        BOUND_WALLET_ID,
        JSON.stringify(["payments:write"])
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
      .prepare(
        `INSERT INTO private_channels (id, organization_id, project_id, instance_id, name, is_default)
         VALUES (?, ?, ?, ?, 'History', false)`
      )
      .bind(CHANNEL_ID, ORGANIZATION_ID, PROJECT_ID, INSTANCE_ID),
    db
      .prepare(
        `INSERT INTO private_channel_users
           (id, organization_id, project_id, user_id, instance_id, name, is_default,
            spc_user_id, spc_username, spc_credential_ciphertext)
         VALUES
           (?, ?, ?, ?, ?, 'Default', true, 'spc-hs-actor', 'actor', 'cipher-actor'),
           (?, ?, ?, ?, ?, 'Recipient', false, 'spc-hs-recipient', 'recipient', 'cipher-recipient')`
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
        INSTANCE_ID
      ),
    db
      .prepare(
        `INSERT INTO private_channel_memberships (id, channel_id, private_channel_user_id, added_by)
         VALUES ('pcm-hs-actor', ?, ?, ?)`
      )
      .bind(CHANNEL_ID, ACTOR_PC_USER_ID, ACTOR_USER_ID),
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, default_wallet_id, status)
         VALUES ('cust-hs', ?, ?, 'privy', '{}', ?, 'active')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, BOUND_WALLET_ID),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES ('csd-hs', ?, ?, 'cust-hs')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES
           ('cw-hs-bound', 'cust-hs', ?, ?, 'Bound', 'transfer', 'active'),
           ('cw-hs-other', 'cust-hs', ?, ?, 'Other', 'transfer', 'active')`
      )
      .bind(BOUND_WALLET_ID, BOUND_ADDRESS, OTHER_WALLET_ID, OTHER_ADDRESS),
    db
      .prepare(
        `INSERT INTO private_channel_verified_wallets
           (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey)
         VALUES
           ('pcvw-hs-bound', ?, ?, ?, ?, ?, ?),
           ('pcvw-hs-other', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ORGANIZATION_ID,
        PROJECT_ID,
        ACTOR_PC_USER_ID,
        INSTANCE_ID,
        BOUND_WALLET_ID,
        BOUND_ADDRESS,
        ORGANIZATION_ID,
        PROJECT_ID,
        RECIPIENT_PC_USER_ID,
        INSTANCE_ID,
        OTHER_WALLET_ID,
        OTHER_ADDRESS
      ),
  ]);
}

async function seedDeposit(input: {
  id: string;
  walletId: string;
  projectId?: string;
}): Promise<void> {
  const row = await createPrivateChannelDepositRepository(env).createDeposit({
    organizationId: ORGANIZATION_ID,
    projectId: input.projectId ?? PROJECT_ID,
    instanceId: INSTANCE_ID,
    walletId: input.walletId,
    depositor: input.walletId === OTHER_WALLET_ID ? OTHER_ADDRESS : BOUND_ADDRESS,
    recipient: RECIPIENT_ADDRESS,
    mint: MINT_ADDRESS,
    amount: "1.5",
    context: {},
    idempotencyKey: `idem-${input.id}`,
    idempotencyFingerprint: buildPrivateChannelDepositFingerprint({
      instanceId: INSTANCE_ID,
      walletId: input.walletId,
      recipient: RECIPIENT_ADDRESS,
      mint: MINT_ADDRESS,
      amount: "1.5",
    }),
  });
  if (!row) throw new Error(`Failed to seed deposit ${input.id}`);
  await getDb(env)
    .prepare("UPDATE private_channel_deposits SET id = ? WHERE id = ?")
    .bind(input.id, row.id)
    .run();
}

async function seedWithdrawal(input: { id: string; walletId: string }): Promise<void> {
  const row = await createPrivateChannelWithdrawalRepository(env).createWithdrawal({
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    walletId: input.walletId,
    owner: input.walletId === OTHER_WALLET_ID ? OTHER_ADDRESS : BOUND_ADDRESS,
    destination: RECIPIENT_ADDRESS,
    mint: MINT_ADDRESS,
    amount: "1.5",
    context: {},
    idempotencyKey: `idem-${input.id}`,
    idempotencyFingerprint: buildPrivateChannelDepositFingerprint({
      instanceId: INSTANCE_ID,
      walletId: input.walletId,
      recipient: RECIPIENT_ADDRESS,
      mint: MINT_ADDRESS,
      amount: "1.5",
    }),
  });
  if (!row) throw new Error(`Failed to seed withdrawal ${input.id}`);
  await getDb(env)
    .prepare("UPDATE private_channel_withdrawals SET id = ? WHERE id = ?")
    .bind(input.id, row.id)
    .run();
}

async function seedTransfer(input: { id: string; senderWalletId: string }): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO private_channel_transfers (
         id, organization_id, project_id, instance_id, channel_id,
         sender_private_channel_user_id, recipient_private_channel_user_id,
         sender_wallet_id, recipient_verified_wallet_id, sender, recipient,
         mint, amount, status, signature
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.5', 'submitted', 'sig-hs')`
    )
    .bind(
      input.id,
      ORGANIZATION_ID,
      PROJECT_ID,
      INSTANCE_ID,
      CHANNEL_ID,
      input.senderWalletId === OTHER_WALLET_ID ? RECIPIENT_PC_USER_ID : ACTOR_PC_USER_ID,
      RECIPIENT_PC_USER_ID,
      input.senderWalletId,
      input.senderWalletId === OTHER_WALLET_ID ? "pcvw-hs-other" : "pcvw-hs-bound",
      input.senderWalletId === OTHER_WALLET_ID ? OTHER_ADDRESS : BOUND_ADDRESS,
      RECIPIENT_ADDRESS,
      MINT_ADDRESS
    )
    .run();
}

async function seedHistory(): Promise<void> {
  await seedDeposit({ id: "dep-hs-bound", walletId: BOUND_WALLET_ID });
  await seedDeposit({ id: "dep-hs-other", walletId: OTHER_WALLET_ID });
  await seedDeposit({
    id: "dep-hs-other-project",
    walletId: BOUND_WALLET_ID,
    projectId: OTHER_PROJECT_ID,
  });
  await seedWithdrawal({ id: "wd-hs-bound", walletId: BOUND_WALLET_ID });
  await seedWithdrawal({ id: "wd-hs-other", walletId: OTHER_WALLET_ID });
  await seedTransfer({ id: "pct-hs-bound", senderWalletId: BOUND_WALLET_ID });
  await seedTransfer({ id: "pct-hs-other", senderWalletId: OTHER_WALLET_ID });
}

describe("Private Channels — movement-history wallet scope", () => {
  afterAll(() => {
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
  });

  beforeEach(async () => {
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedRouteState();
    await seedHistory();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("lists only the bound wallet's deposits for a selected-scope key", async () => {
    const response = await app.request(
      "/v1/private-channels/deposits",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { deposits: Array<{ id: string }> } };
    expect(body.data.deposits.map((deposit) => deposit.id)).toEqual(["dep-hs-bound"]);
  });

  it("404s the unbound wallet's deposit by id for a selected-scope key", async () => {
    const other = await app.request(
      "/v1/private-channels/deposits/dep-hs-other",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(other.status).toBe(404);

    const bound = await app.request(
      "/v1/private-channels/deposits/dep-hs-bound",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ data: { id: "dep-hs-bound" } });
  });

  it("lists only the bound wallet's withdrawals for a selected-scope key", async () => {
    const response = await app.request(
      "/v1/private-channels/withdrawals",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { withdrawals: Array<{ id: string }> } };
    expect(body.data.withdrawals.map((withdrawal) => withdrawal.id)).toEqual(["wd-hs-bound"]);
  });

  it("404s the unbound wallet's withdrawal by id for a selected-scope key", async () => {
    const other = await app.request(
      "/v1/private-channels/withdrawals/wd-hs-other",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(other.status).toBe(404);

    const bound = await app.request(
      "/v1/private-channels/withdrawals/wd-hs-bound",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ data: { id: "wd-hs-bound" } });
  });

  it("lists only transfers sent from the bound wallet for a selected-scope key", async () => {
    const response = await app.request(
      "/v1/private-channels/transfers",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { transfers: Array<{ id: string }> } };
    expect(body.data.transfers.map((transfer) => transfer.id)).toEqual(["pct-hs-bound"]);
  });

  it("404s another wallet's transfer by id for a selected-scope key", async () => {
    const other = await app.request(
      "/v1/private-channels/transfers/pct-hs-other",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(other.status).toBe(404);

    const bound = await app.request(
      "/v1/private-channels/transfers/pct-hs-bound",
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ data: { id: "pct-hs-bound" } });
  });

  it("keeps the channel filter working inside the wallet scope", async () => {
    const response = await app.request(
      `/v1/private-channels/transfers?channelId=${CHANNEL_ID}`,
      { headers: keyHeaders(SCOPED_API_KEY) },
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { transfers: Array<{ id: string }> } };
    expect(body.data.transfers.map((transfer) => transfer.id)).toEqual(["pct-hs-bound"]);
  });

  it("returns no history rows for a selected scope with no payments:read binding", async () => {
    for (const path of ["/deposits", "/withdrawals", "/transfers"]) {
      const response = await app.request(
        `/v1/private-channels${path}`,
        { headers: keyHeaders(NO_READ_BINDING_API_KEY) },
        env
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, Record<string, unknown[]>>;
      const [collection] = Object.keys(body.data);
      expect(body.data[collection]).toEqual([]);
    }
    for (const path of [
      "/deposits/dep-hs-bound",
      "/withdrawals/wd-hs-bound",
      "/transfers/pct-hs-bound",
    ]) {
      const response = await app.request(
        `/v1/private-channels${path}`,
        { headers: keyHeaders(NO_READ_BINDING_API_KEY) },
        env
      );
      expect(response.status).toBe(404);
    }
  });

  it.each([
    ["all-wallet key", () => keyHeaders(ALL_API_KEY)],
    ["session", () => sessionHeaders()],
  ])("keeps full project visibility for a %s", async (_label, buildHeaders) => {
    const deposits = await app.request(
      "/v1/private-channels/deposits",
      { headers: buildHeaders() },
      env
    );
    expect(deposits.status).toBe(200);
    const depositBody = (await deposits.json()) as { data: { deposits: Array<{ id: string }> } };
    expect(depositBody.data.deposits.map((deposit) => deposit.id).sort()).toEqual([
      "dep-hs-bound",
      "dep-hs-other",
    ]);

    const withdrawals = await app.request(
      "/v1/private-channels/withdrawals",
      { headers: buildHeaders() },
      env
    );
    expect(withdrawals.status).toBe(200);
    const withdrawalBody = (await withdrawals.json()) as {
      data: { withdrawals: Array<{ id: string }> };
    };
    expect(withdrawalBody.data.withdrawals.map((withdrawal) => withdrawal.id).sort()).toEqual([
      "wd-hs-bound",
      "wd-hs-other",
    ]);

    const transfers = await app.request(
      "/v1/private-channels/transfers",
      { headers: buildHeaders() },
      env
    );
    expect(transfers.status).toBe(200);
    const transferBody = (await transfers.json()) as { data: { transfers: Array<{ id: string }> } };
    expect(transferBody.data.transfers.map((transfer) => transfer.id).sort()).toEqual([
      "pct-hs-bound",
      "pct-hs-other",
    ]);
  });

  it("still 404s another project's deposit for every caller shape", async () => {
    for (const buildHeaders of [
      () => keyHeaders(SCOPED_API_KEY),
      () => keyHeaders(ALL_API_KEY),
      () => sessionHeaders(),
    ]) {
      const response = await app.request(
        "/v1/private-channels/deposits/dep-hs-other-project",
        { headers: buildHeaders() },
        env
      );
      expect(response.status).toBe(404);
    }
  });
});
