/**
 * Authorization and reservation tests for the two instance-scoped Private
 * Channels money routes: `POST /deposits` and `POST /withdrawals`.
 *
 * Both routes used to accept ANY custody wallet in the project as their source,
 * gated only on `payments:write`. That let a caller deposit out of a wallet that
 * was never enrolled in Private Channels, and — the sharper edge — burn the
 * channel balance behind one while naming an arbitrary payout address. The gate
 * is now `private_channel_verified_wallets`: the wallet must have completed the
 * challenge → sign → verify handshake under the project's default principal on
 * this instance. These tests hold that gate, plus the `Idempotency-Key`
 * reservation that keeps a retry from moving funds twice.
 *
 * The principal is project-scoped, not per-user (migration 0073), so the seeds
 * here write the CURRENT row shape — `instance_id` + `is_default`, no `user_id`.
 * Seeding the legacy user-keyed shape is what let the first version of the seam
 * pass these tests while answering 403 against every real post-0073 project.
 *
 * The services are mocked: what is under test is the ACCESS DECISION and what
 * the route hands the service, not the chain work behind it.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, PrivateChannelDeposit, PrivateChannelWithdrawal } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const { createChannelDepositMock, createChannelWithdrawalMock, resolveGatewayAuthMock } =
  vi.hoisted(() => ({
    createChannelDepositMock: vi.fn(),
    createChannelWithdrawalMock: vi.fn(),
    resolveGatewayAuthMock: vi.fn(),
  }));

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

const ORGANIZATION_ID = "org_pc_value";
const PROJECT_ID = "prj_pc_value";
const SESSION_ID = "ses_pc_value";
const OTHER_SESSION_ID = "ses_pc_value_other";
const ACTOR_USER_ID = "usr_pc_value_actor";
const COLLEAGUE_USER_ID = "usr_pc_value_colleague";
const NON_MEMBER_USER_ID = "usr_pc_value_non_member";
const NON_MEMBER_SESSION_ID = "ses_pc_value_non_member";
const INSTANCE_ID = "pci_pc_value";
const ACTOR_PC_USER_ID = "pcu_pc_value_actor";
const COLLEAGUE_PC_USER_ID = "pcu_pc_value_colleague";
const ACTOR_WALLET_ID = "wallet_pc_value_actor";
const COLLEAGUE_WALLET_ID = "wallet_pc_value_colleague";
const UNVERIFIED_WALLET_ID = "wallet_pc_value_unverified";
const ACTOR_ADDRESS = "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz";
const COLLEAGUE_ADDRESS = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
const UNVERIFIED_ADDRESS = "Vote111111111111111111111111111111111111111";
/** A real address nobody verified on this instance — a legitimate payout target. */
const EXTERNAL_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ESCROW_PROGRAM_ID = "EscrowProgram11111111111111111111111111111";
const WITHDRAW_PROGRAM_ID = "WithdrawProgram111111111111111111111111111";
const ESCROW_INSTANCE_ADDRESS = "EscrowInstance111111111111111111111111111";
const API_KEY = {
  id: "key_pc_value",
  raw: "sk_test_private_channel_value",
  prefix: "sk_test_pcv",
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

function sessionHeaders(extra: Record<string, string> = {}) {
  return {
    Cookie: `sdp_session=${SESSION_ID}`,
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

function depositDto(overrides: Partial<PrivateChannelDeposit> = {}): PrivateChannelDeposit {
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

function withdrawalDto(
  overrides: Partial<PrivateChannelWithdrawal> = {}
): PrivateChannelWithdrawal {
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
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?), (?, ?, ?, 'session', ?), (?, ?, ?, 'session', ?)`
      )
      .bind(
        SESSION_ID,
        ACTOR_USER_ID,
        ORGANIZATION_ID,
        new Date(Date.now() + 60_000).toISOString(),
        OTHER_SESSION_ID,
        COLLEAGUE_USER_ID,
        ORGANIZATION_ID,
        new Date(Date.now() + 60_000).toISOString(),
        NON_MEMBER_SESSION_ID,
        NON_MEMBER_USER_ID,
        ORGANIZATION_ID,
        new Date(Date.now() + 60_000).toISOString()
      ),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Value Project', 'pc-value-project', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, ACTOR_USER_ID),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES
           ('pm_pc_value_actor', ?, ?, 'admin'),
           ('pm_pc_value_colleague', ?, ?, 'admin'),
           ('pm_pc_value_nonmember', ?, ?, 'admin')`
      )
      .bind(
        PROJECT_ID,
        ACTOR_USER_ID,
        PROJECT_ID,
        COLLEAGUE_USER_ID,
        PROJECT_ID,
        NON_MEMBER_USER_ID
      ),
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
      .prepare(
        // Principals are project-scoped and instance-scoped since 0073: `user_id`
        // is nullable and carries no meaning here, so these rows are seeded the
        // way the application now writes them — the acting one is the instance's
        // DEFAULT principal, which is what the access seam resolves. Seeding the
        // legacy user-keyed shape would let a seam that looks members up by user
        // id pass here while answering 403 against a real project.
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
           (id, organization_id, project_id, provider, config_encrypted, default_wallet_id, status)
         VALUES ('cust-pcv', ?, ?, 'turnkey', '{}', ?, 'active')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, ACTOR_WALLET_ID),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES ('csd-pcv', ?, ?, 'cust-pcv')`
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
    // The actor verified their own wallet; the colleague verified theirs. Nobody
    // verified `UNVERIFIED_WALLET_ID`, and nobody verified EXTERNAL_ADDRESS.
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

async function postDeposit(
  body: Record<string, unknown>,
  headers: Record<string, string> = sessionHeaders()
) {
  return app.request(
    "/v1/private-channels/deposits",
    { method: "POST", headers, body: JSON.stringify(body) },
    env
  );
}

async function postWithdrawal(
  body: Record<string, unknown>,
  headers: Record<string, string> = sessionHeaders()
) {
  return app.request(
    "/v1/private-channels/withdrawals",
    { method: "POST", headers, body: JSON.stringify(body) },
    env
  );
}

describe("Private Channels — deposit and withdrawal access", () => {
  beforeEach(async () => {
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedRouteState();
    createChannelDepositMock.mockReset();
    createChannelWithdrawalMock.mockReset();
    resolveGatewayAuthMock.mockReset();
    createChannelDepositMock.mockResolvedValue(depositDto());
    createChannelWithdrawalMock.mockResolvedValue(withdrawalDto());
    resolveGatewayAuthMock.mockResolvedValue({
      current: "spc-jwt",
      refresh: vi.fn(async () => "spc-jwt"),
      pcUserId: ACTOR_PC_USER_ID,
    });
  });

  afterEach(async () => {
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
    await clearKVStores(env);
  });

  /**
   * The SPC identity is a PROJECT-scoped principal since 0073, not a per-user
   * membership, so value movement cannot be gated on who is calling — the seam
   * resolves the instance's default principal, exactly as member transfers do.
   * What still has to hold is that the project HAS one to act as.
   */
  it("refuses a value movement when the project has no active principal", async () => {
    await getDb(env)
      .prepare("UPDATE private_channel_users SET is_default = FALSE WHERE id = ?")
      .bind(ACTOR_PC_USER_ID)
      .run();

    expect((await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" })).status).toBe(403);
    expect((await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" })).status).toBe(403);
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  /**
   * Enrolment is the gate, and it does not depend on the caller's own identity:
   * a session belonging to nobody in particular, and an API key, both get the
   * same refusal for a wallet that was never verified under the principal.
   */
  it.each([
    [
      "a non-member session",
      () => sessionHeaders({ Cookie: `sdp_session=${NON_MEMBER_SESSION_ID}` }),
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

  it("refuses a custody wallet that is not enrolled under the principal", async () => {
    expect((await postDeposit({ walletId: UNVERIFIED_WALLET_ID, amount: "1.5" })).status).toBe(403);
    expect((await postWithdrawal({ walletId: UNVERIFIED_WALLET_ID, amount: "1.5" })).status).toBe(
      403
    );
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  // The finding in one line: `payments:write` used to be enough to spend out of
  // any project custody wallet, or to burn the channel balance behind it. This
  // one is verified under a DIFFERENT, non-default principal — enrolled in SPC,
  // but not under the principal this project acts as.
  it("does not let a caller move funds out of another principal's verified wallet", async () => {
    expect((await postDeposit({ walletId: COLLEAGUE_WALLET_ID, amount: "1.5" })).status).toBe(403);
    expect((await postWithdrawal({ walletId: COLLEAGUE_WALLET_ID, amount: "1.5" })).status).toBe(
      403
    );
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it("credits only addresses verified on this instance", async () => {
    // A channel balance is only spendable by a verified wallet, so crediting an
    // unverified address could only ever strand it.
    const external = await postDeposit({
      walletId: ACTOR_WALLET_ID,
      amount: "1.5",
      recipient: EXTERNAL_ADDRESS,
    });
    expect(external.status).toBe(400);
    expect(createChannelDepositMock).not.toHaveBeenCalled();

    const colleague = await postDeposit({
      walletId: ACTOR_WALLET_ID,
      amount: "1.5",
      recipient: COLLEAGUE_ADDRESS,
    });
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
        (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5", recipient: unsafe })).status
      ).toBe(400);
      expect(
        (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5", destination: unsafe }))
          .status
      ).toBe(400);
      expect(createChannelDepositMock).not.toHaveBeenCalled();
      expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
    }
  );

  // A withdrawal exists to move value OUT, and the caller can only ever burn a
  // balance they proved control of — so their own payout address is their call.
  it("allows an unverified withdrawal destination", async () => {
    const response = await postWithdrawal({
      walletId: ACTOR_WALLET_ID,
      amount: "1.5",
      destination: EXTERNAL_ADDRESS,
    });

    expect(response.status).toBe(200);
    expect(createChannelWithdrawalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destination: EXTERNAL_ADDRESS })
    );
  });

  it("refuses to move funds without an idempotency key", async () => {
    const headers = sessionHeaders();
    const { "Idempotency-Key": _omitted, ...withoutKey } = headers;

    expect(
      (await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, withoutKey)).status
    ).toBe(400);
    expect(
      (await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" }, withoutKey)).status
    ).toBe(400);
    // Nothing is resolved, signed or broadcast: without a key there is no way to
    // tell a retry from a second movement, so the request never starts.
    expect(createChannelDepositMock).not.toHaveBeenCalled();
    expect(createChannelWithdrawalMock).not.toHaveBeenCalled();
  });

  it("hands the service the resolved wallet, counterparty, acting member and key", async () => {
    expect((await postDeposit({ walletId: ACTOR_WALLET_ID, amount: "1.5" })).status).toBe(200);
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
        // Defaulted to the depositor, which is already verified.
        recipient: ACTOR_ADDRESS,
        idempotencyKey: "idem_pc_value",
      })
    );

    expect((await postWithdrawal({ walletId: ACTOR_WALLET_ID, amount: "1.5" })).status).toBe(200);
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
