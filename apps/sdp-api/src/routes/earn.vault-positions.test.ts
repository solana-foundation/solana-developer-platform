import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const { readVaultPositions, resolveVaultDirectClient } = vi.hoisted(() => {
  const readVaultPositions = vi.fn();
  return {
    readVaultPositions,
    resolveVaultDirectClient: vi.fn((_env: unknown, _provider: string, _deadline: unknown) => ({
      readVaultPositions,
    })),
  };
});

vi.mock("@/services/earn/execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/execution-registry")>()),
  resolveVaultDirectClient,
}));

const ORG = "org_vault_positions";
const USER = "usr_vault_positions";
const PROJECT_A = "prj_vault_positions_a";
const PROJECT_B = "prj_vault_positions_b";
const CONFIG_A = "cfg_vault_positions_a";
const CONFIG_B = "cfg_vault_positions_b";
const WALLET_A = "cwlt_vault_positions_a";
const WALLET_B = "cwlt_vault_positions_b";
const PROVIDER_WALLET_A = "privy_vault_positions_a";
const PROVIDER_WALLET_B = "privy_vault_positions_b";
const PUBLIC_KEY_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PUBLIC_KEY_B = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const API_KEY = { id: "key_vault_positions", raw: "sk_test_vault_positions" };

function cachedKey(): CachedApiKey {
  return {
    id: API_KEY.id,
    organizationId: ORG,
    projectId: PROJECT_A,
    role: "api_admin",
    permissions: ["*"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
}

async function seedScope(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, cachedKey());
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Vault Positions Org", "vault-positions", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "vault-positions@example.com"),
    ...[PROJECT_A, PROJECT_B].map((projectId, index) =>
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, ORG, `Project ${index}`, `vault-positions-${index}`, USER)
    ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'api_admin', '["*"]'::jsonb, 'active')`
      )
      .bind(API_KEY.id, ORG, PROJECT_A, USER, "Vault key", "sk_test_vau", keyHash),
    ...[
      [CONFIG_A, PROJECT_A, WALLET_A, PROVIDER_WALLET_A, PUBLIC_KEY_A],
      [CONFIG_B, PROJECT_B, WALLET_B, PROVIDER_WALLET_B, PUBLIC_KEY_B],
    ].flatMap(([configId, projectId, walletId, providerWalletId, publicKey]) => [
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, status)
           VALUES (?, ?, ?, 'privy', 'encrypted', 'active')`
        )
        .bind(configId, ORG, projectId),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, ?, ?, ?, 'active')`
        )
        .bind(walletId, configId, providerWalletId, publicKey),
    ]),
  ]);
}

async function createPosition(params: {
  projectId?: string;
  walletId?: string;
  providerReference?: string;
  signature?: string;
  requestId?: string;
}) {
  const providerReference = params.providerReference ?? `vault_${crypto.randomUUID()}`;
  const walletId = params.walletId ?? WALLET_A;
  return createPostgresEarnMovementsRepository(getDb(env)).createSignedVaultDepositIntent({
    organizationId: ORG,
    projectId: params.projectId ?? PROJECT_A,
    environment: "sandbox",
    provider: "kamino",
    vaultAddress: providerReference,
    custodyWalletId: walletId,
    sourceAddress: PUBLIC_KEY_A,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    label: `Vault ${providerReference}`,
    requestedAmount: "1",
    signature: params.signature ?? `sig_${crypto.randomUUID()}`,
    signedTransaction: "AQ==",
    lastValidBlockHeight: "12345",
    requestId: params.requestId ?? crypto.randomUUID(),
    idempotencyFingerprint: `fingerprint_${providerReference}`,
    createdBy: USER,
  });
}

function getPositions(query = "") {
  return app.request(
    `/v1/earn/vault-positions${query}`,
    { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
    env
  );
}

function listDeposits(query = "") {
  return app.request(
    `/v1/earn/vault-deposits${query}`,
    { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
    env
  );
}

function getDeposit(movementId: string) {
  return app.request(
    `/v1/earn/vault-deposits/${encodeURIComponent(movementId)}`,
    { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
    env
  );
}

function encodeCursorPayload(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

beforeEach(async () => {
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
  await clearKVStores(env);
  await seedScope();
  vi.clearAllMocks();
  readVaultPositions.mockImplementation(
    async (_ctx: unknown, input: { owner: string; providerReferences: string[] }) =>
      input.providerReferences.map((providerReference) => ({
        providerReference,
        owner: input.owner,
        cluster: "devnet",
        shares: "1",
        withdrawableShares: "1",
        tokenValue: "1",
        tokenMint: TOKEN_MINT,
        shareMint: SHARE_MINT,
      }))
  );
});

describe("GET /v1/earn/vault-positions", () => {
  it("never exposes a sibling project's wallet position to an unbound project key", async () => {
    const own = await createPosition({});
    await createPosition({
      projectId: PROJECT_B,
      walletId: WALLET_B,
      providerReference: "vault_sibling",
    });

    const response = await getPositions();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { positions: Array<{ id: string; custodyWalletId: string; label: string }> };
    };

    expect(body.data.positions).toEqual([
      expect.objectContaining({
        id: own.position.id,
        custodyWalletId: WALLET_A,
        label: own.position.label,
      }),
    ]);
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
  });

  it("exposes no rows for an ambiguous selected-wallet provider id", async () => {
    const orgConfigId = "cfg_vault_positions_org_fallback";
    const orgWalletId = "cwlt_vault_positions_org_fallback";
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, status)
           VALUES (?, ?, NULL, 'privy', 'encrypted', 'active')`
        )
        .bind(orgConfigId, ORG),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, ?, ?, ?, 'active')`
        )
        .bind(orgWalletId, orgConfigId, PROVIDER_WALLET_A, PUBLIC_KEY_B),
    ]);
    await createPosition({ providerReference: "vault_project_binding" });
    await createPosition({
      walletId: orgWalletId,
      providerReference: "vault_org_binding",
      signature: "sig_org_binding",
    });
    const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, {
      ...cachedKey(),
      signingWalletId: PROVIDER_WALLET_A,
      walletBindings: [{ walletId: PROVIDER_WALLET_A, permissions: ["earn:read"] }],
    });

    const response = await getPositions();
    const body = (await response.json()) as { data: { positions: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.data.positions).toEqual([]);
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("returns stable bounded keyset pages without overlap", async () => {
    await createPosition({ providerReference: "vault_page_1" });
    await createPosition({ providerReference: "vault_page_2" });
    await createPosition({ providerReference: "vault_page_3" });

    const firstResponse = await getPositions("?limit=2");
    const first = (await firstResponse.json()) as {
      data: { positions: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
    };
    expect(first.data.positions).toHaveLength(2);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.nextCursor).toEqual(expect.any(String));

    const secondResponse = await getPositions(
      `?limit=2&before=${encodeURIComponent(first.data.nextCursor ?? "")}`
    );
    const second = (await secondResponse.json()) as {
      data: { positions: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
    };
    expect(second.data.positions).toHaveLength(1);
    expect(second.data.hasMore).toBe(false);
    expect(second.data.nextCursor).toBeNull();
    expect(
      first.data.positions.some((row) => second.data.positions.some((next) => next.id === row.id))
    ).toBe(false);
  });

  it("does not attach live balances under a mismatched asset identity", async () => {
    await createPosition({ providerReference: "vault_identity_mismatch" });
    readVaultPositions.mockResolvedValue([
      {
        providerReference: "vault_identity_mismatch",
        owner: PUBLIC_KEY_A,
        cluster: "devnet",
        shares: "99",
        withdrawableShares: "99",
        tokenValue: "99",
        tokenMint: PUBLIC_KEY_B,
        shareMint: SHARE_MINT,
      },
    ]);

    const response = await getPositions();
    const body = (await response.json()) as {
      data: { positions: Array<Record<string, unknown>> };
    };

    expect(response.status).toBe(200);
    expect(body.data.positions).toHaveLength(1);
    expect(body.data.positions[0]).toMatchObject({
      tokenMint: TOKEN_MINT,
      shareMint: SHARE_MINT,
    });
    expect(body.data.positions[0]).not.toHaveProperty("shares");
    expect(body.data.positions[0]).not.toHaveProperty("tokenValue");
  });

  it("hydrates every custody row that projects the same owner and vault", async () => {
    const duplicateWalletId = "cwlt_vault_positions_duplicate_owner";
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(duplicateWalletId, CONFIG_A, "privy_vault_positions_duplicate_owner", PUBLIC_KEY_A)
      .run();
    await createPosition({ providerReference: "vault_shared_owner" });
    await createPosition({
      walletId: duplicateWalletId,
      providerReference: "vault_shared_owner",
      signature: "sig_vault_shared_owner",
    });
    readVaultPositions.mockResolvedValue([
      {
        providerReference: "vault_shared_owner",
        owner: PUBLIC_KEY_A,
        cluster: "devnet",
        shares: "8",
        withdrawableShares: "7",
        tokenValue: "6.5",
        tokenMint: TOKEN_MINT,
        shareMint: SHARE_MINT,
      },
    ]);

    const response = await getPositions();
    const body = (await response.json()) as {
      data: { positions: Array<Record<string, unknown>> };
    };

    expect(response.status).toBe(200);
    expect(body.data.positions).toHaveLength(2);
    expect(body.data.positions).toEqual([
      expect.objectContaining({ shares: "8", withdrawableShares: "7", tokenValue: "6.5" }),
      expect.objectContaining({ shares: "8", withdrawableShares: "7", tokenValue: "6.5" }),
    ]);
    expect(readVaultPositions).toHaveBeenCalledWith(expect.anything(), {
      owner: PUBLIC_KEY_A,
      providerReferences: ["vault_shared_owner"],
    });
    expect(resolveVaultDirectClient).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["owner", { owner: PUBLIC_KEY_B }],
    ["amount", { shares: "NaN" }],
    ["withdrawable amount", { withdrawableShares: "NaN" }],
  ] as const)("does not attach live balances under a mismatched %s", async (kind, override) => {
    const providerReference = `vault_${kind}_mismatch`;
    await createPosition({ providerReference });
    readVaultPositions.mockResolvedValue([
      {
        vaultAddress: providerReference,
        owner: PUBLIC_KEY_A,
        cluster: "devnet",
        shares: "99",
        withdrawableShares: "99",
        tokenValue: "99",
        tokenMint: TOKEN_MINT,
        shareMint: SHARE_MINT,
        ...override,
      },
    ]);

    const response = await getPositions();
    const body = (await response.json()) as {
      data: { positions: Array<Record<string, unknown>> };
    };

    expect(response.status).toBe(200);
    expect(body.data.positions).toHaveLength(1);
    expect(body.data.positions[0]).not.toHaveProperty("shares");
    expect(body.data.positions[0]).not.toHaveProperty("tokenValue");
  });

  it("rejects an invalid cursor and caps page size", async () => {
    expect((await getPositions("?before=not-a-cursor")).status).toBe(400);
    expect((await getPositions("?limit=101")).status).toBe(400);
  });

  it.each([
    [
      "malformed timestamp",
      "not-a-timestamp",
      "earn_vault_position_00000000-0000-4000-8000-000000000000",
    ],
    [
      "noncanonical timestamp",
      "2026-08-17T16:29:31Z",
      "earn_vault_position_00000000-0000-4000-8000-000000000000",
    ],
    [
      "noncanonical position id casing",
      "2026-08-17T16:29:31.000Z",
      "earn_vault_position_00000000-0000-4000-8000-000000000ABC",
    ],
    // An id shape the keyset tuple cannot compare correctly: PostgreSQL orders it
    // as text, so uppercase would sort wrongly against generated lowercase ids.
    ["empty position id", "2026-08-17T16:29:31.000Z", ""],
    ["over-long position id", "2026-08-17T16:29:31.000Z", `earn_position_${"a".repeat(200)}`],
  ])("rejects a decodable cursor with a %s", async (_case, createdAt, id) => {
    const cursor = encodeCursorPayload(createdAt, id);
    const response = await getPositions(`?before=${encodeURIComponent(cursor)}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Invalid vault position pagination cursor",
      },
    });
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("accepts an id it does not recognise, because a cursor is a bound and not a grant", async () => {
    // Holdings carry ids from two eras — `earn_vault_position_…` preserved by the
    // unification and `earn_position_…` for newer ones — so the cursor validates
    // SHAPE rather than a prefix. That is safe rather than lax: the id lands in
    // `(created_at, id) < (?, ?)` while organization, environment and wallet scope
    // are separate conditions, so an unrecognised one can only bound the page.
    await createPosition({ providerReference: "vault_unknown_cursor_id" });

    const cursor = encodeCursorPayload("2999-01-01T00:00:00.000Z", "earn_position_unrecognised");
    const response = await getPositions(`?before=${encodeURIComponent(cursor)}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { positions: Array<{ id: string }> } };
    expect(body.data.positions).toHaveLength(1);
  });

  it("caps live wallet hydration at eight concurrent calls", async () => {
    for (let index = 0; index < 10; index += 1) {
      const walletId = `cwlt_vault_positions_many_${index}`;
      await getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, ?, ?, ?, 'active')`
        )
        .bind(walletId, CONFIG_A, `privy_many_${index}`, `public_key_many_${index}`)
        .run();
      await createPosition({
        walletId,
        providerReference: `vault_many_${index}`,
        signature: `sig_many_${index}`,
        requestId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      });
    }

    let active = 0;
    let maximum = 0;
    readVaultPositions.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return [];
    });

    const response = await getPositions("?limit=20");

    expect(response.status).toBe(200);
    expect(readVaultPositions).toHaveBeenCalledTimes(10);
    expect(maximum).toBe(8);
  });
});

/**
 * The deposit READ shares this file because it shares this route's scope rule:
 * both resolve which custody wallets the caller may see through
 * `listReadableEarnVaultWallets`, and a binding that hides a position has to
 * hide that position's deposits too. Testing them apart is how the two drift.
 */

describe("GET /v1/earn/vault-deposits/:movementId", () => {
  it("reports the recorded deposit so an unconfirmed signature stays answerable", async () => {
    const created = await createPosition({ providerReference: "vault_read_own" });

    const response = await getDeposit(created.movement.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        deposit: {
          movementId: string;
          positionId: string;
          provider: string;
          providerReference: string;
          status: string;
          signature: string;
          amount: string;
          failureReason: string | null;
          confirmedAt: string | null;
        };
      };
    };

    expect(body.data.deposit).toEqual({
      movementId: created.movement.id,
      positionId: created.position.id,
      provider: "kamino",
      providerReference: "vault_read_own",
      // Recorded BEFORE broadcast, which is the whole reason this route exists.
      status: "pending",
      signature: created.movement.signature,
      amount: "1",
      failureReason: null,
      createdAt: created.movement.created_at,
      confirmedAt: null,
    });
  });

  it("reads back the terminal state the reconciliation sweep wrote", async () => {
    const created = await createPosition({ providerReference: "vault_read_settled" });
    await createPostgresEarnMovementsRepository(getDb(env)).advanceVaultMovement({
      movementId: created.movement.id,
      organizationId: ORG,
      toStatus: "failed",
      failureReason: "Blockhash expired without the transaction landing",
    });

    const response = await getDeposit(created.movement.id);
    const body = (await response.json()) as {
      data: { deposit: { status: string; failureReason: string | null } };
    };

    expect(response.status).toBe(200);
    expect(body.data.deposit.status).toBe("failed");
    expect(body.data.deposit.failureReason).toBe(
      "Blockhash expired without the transaction landing"
    );
  });

  it("hides a sibling project's wallet deposit from an unbound project key", async () => {
    const sibling = await createPosition({
      projectId: PROJECT_B,
      walletId: WALLET_B,
      providerReference: "vault_read_sibling",
    });

    // 404, not 403: a caller who may not see the movement must not learn that
    // it exists.
    expect((await getDeposit(sibling.movement.id)).status).toBe(404);
  });

  it("refuses a withdrawal from the deposit path", async () => {
    const created = await createPosition({ providerReference: "vault_read_direction" });
    await getDb(env)
      .prepare(
        `UPDATE earn_movements
            SET direction = 'withdrawal', denomination = ?, min_shares_out = NULL
          WHERE id = ?`
      )
      .bind(SHARE_MINT, created.movement.id)
      .run();

    expect((await getDeposit(created.movement.id)).status).toBe(404);
  });

  it("refuses a movement recorded in another environment", async () => {
    // Written straight to the tables so the environment is the ONLY thing that
    // differs: same organization, same in-scope wallet, direction `deposit`.
    // `createSignedDepositIntent` derives the environment from the project, so
    // it cannot produce this row, and the composite position FK means the two
    // rows have to be inserted mismatched rather than updated after the fact.
    const positionId = `earn_vault_position_${crypto.randomUUID()}`;
    const movementId = `earn_vault_movement_${crypto.randomUUID()}`;
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO earn_positions (
             id, organization_id, project_id, environment, provider, kind, vault_address,
             custody_wallet_id, share_mint, token_mint, label, created_by, activated_at
           ) VALUES (?, ?, ?, 'production', 'kamino', 'vault_direct', 'vault_read_environment',
                     ?, ?, ?, 'Production vault', ?, sdp_iso_now())`
        )
        .bind(positionId, ORG, PROJECT_A, WALLET_A, SHARE_MINT, TOKEN_MINT, USER),
      getDb(env)
        .prepare(
          `INSERT INTO earn_movements (
             id, organization_id, project_id, environment, position_id, provider,
             execution_model, vault_address, custody_wallet_id, direction, status,
             request_id, idempotency_fingerprint, denomination, amount_requested,
             signature, signed_transaction, last_valid_block_height, created_by
           ) VALUES (?, ?, ?, 'production', ?, 'kamino', 'vault_direct',
                     'vault_read_environment', ?, 'deposit', 'requested', ?,
                     'fingerprint_environment', ?, '1', ?, 'AQ==', '12345', ?)`
        )
        .bind(
          movementId,
          ORG,
          PROJECT_A,
          positionId,
          WALLET_A,
          crypto.randomUUID(),
          TOKEN_MINT,
          `sig_${crypto.randomUUID()}`,
          USER
        ),
    ]);

    expect((await getDeposit(movementId)).status).toBe(404);
  });

  it("answers 404 for an id this organization has never held", async () => {
    expect((await getDeposit(`earn_vault_movement_${crypto.randomUUID()}`)).status).toBe(404);
  });
});

/**
 * The LIST is the discovery tier: it is what lets a client re-derive its own
 * in-flight deposits after losing local state, and — via `?requestId=` — find a
 * deposit that did not exist when it was requested because policy held it for
 * approval.
 */
describe("GET /v1/earn/vault-deposits", () => {
  it("returns this workspace's deposits newest first", async () => {
    const first = await createPosition({ providerReference: "vault_list_1" });
    const second = await createPosition({ providerReference: "vault_list_2" });

    const response = await listDeposits();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        deposits: Array<{ movementId: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };

    expect(body.data.deposits.map((deposit) => deposit.movementId)).toEqual([
      second.movement.id,
      first.movement.id,
    ]);
    expect(body.data.hasMore).toBe(false);
    expect(body.data.nextCursor).toBeNull();
  });

  it("never lists a sibling project's wallet deposit", async () => {
    const own = await createPosition({ providerReference: "vault_list_own" });
    await createPosition({
      projectId: PROJECT_B,
      walletId: WALLET_B,
      providerReference: "vault_list_sibling",
    });

    const body = (await (await listDeposits()).json()) as {
      data: { deposits: Array<{ movementId: string }> };
    };

    expect(body.data.deposits.map((deposit) => deposit.movementId)).toEqual([own.movement.id]);
  });

  it("omits a withdrawal, which is not a deposit", async () => {
    const deposit = await createPosition({ providerReference: "vault_list_deposit" });
    const withdrawal = await createPosition({ providerReference: "vault_list_withdrawal" });
    await getDb(env)
      .prepare(
        `UPDATE earn_movements
            SET direction = 'withdrawal', denomination = ?, min_shares_out = NULL
          WHERE id = ?`
      )
      .bind(SHARE_MINT, withdrawal.movement.id)
      .run();

    const body = (await (await listDeposits()).json()) as {
      data: { deposits: Array<{ movementId: string }> };
    };

    expect(body.data.deposits.map((deposit) => deposit.movementId)).toEqual([deposit.movement.id]);
  });

  it("pages by keyset without overlap", async () => {
    await createPosition({ providerReference: "vault_list_page_1" });
    await createPosition({ providerReference: "vault_list_page_2" });
    await createPosition({ providerReference: "vault_list_page_3" });

    const first = (await (await listDeposits("?limit=2")).json()) as {
      data: {
        deposits: Array<{ movementId: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };
    expect(first.data.deposits).toHaveLength(2);
    expect(first.data.hasMore).toBe(true);

    const second = (await (
      await listDeposits(`?limit=2&before=${encodeURIComponent(first.data.nextCursor ?? "")}`)
    ).json()) as {
      data: {
        deposits: Array<{ movementId: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };
    expect(second.data.deposits).toHaveLength(1);
    expect(second.data.hasMore).toBe(false);
    expect(
      first.data.deposits.some((row) =>
        second.data.deposits.some((next) => next.movementId === row.movementId)
      )
    ).toBe(false);
  });

  it("rejects a malformed cursor rather than silently returning the first page", async () => {
    expect((await listDeposits("?before=not-a-cursor")).status).toBe(400);
  });

  it("finds a deposit by the caller's own idempotency key", async () => {
    // This is the approval-gated mechanism: a policy hold returns no movement
    // id, but the approval executor replays the ORIGINAL Idempotency-Key, so the
    // movement it eventually creates is findable by the key the caller kept.
    const requestId = `caller-chosen-${crypto.randomUUID()}`;
    const created = await createPosition({ providerReference: "vault_by_key", requestId });

    const body = (await (
      await listDeposits(`?requestId=${encodeURIComponent(requestId)}`)
    ).json()) as { data: { deposits: Array<{ movementId: string }> } };

    expect(body.data.deposits.map((deposit) => deposit.movementId)).toEqual([created.movement.id]);
  });

  it("answers empty for a key that resolves outside the caller's scope", async () => {
    // A key is caller-chosen and may be one character, so it must never work as
    // a capability — the sibling-project scoping applies to it exactly as it
    // does to the movement id.
    const requestId = "1";
    await createPosition({
      projectId: PROJECT_B,
      walletId: WALLET_B,
      providerReference: "vault_by_key_sibling",
      requestId,
    });

    const body = (await (
      await listDeposits(`?requestId=${encodeURIComponent(requestId)}`)
    ).json()) as { data: { deposits: unknown[] } };

    expect(body.data.deposits).toEqual([]);
  });

  it("returns only in-flight movements when asked, so recovery cannot be paged out", async () => {
    const inFlight = await createPosition({ providerReference: "vault_settled_pending" });
    const settled = await createPosition({ providerReference: "vault_settled_confirmed" });
    await createPostgresEarnMovementsRepository(getDb(env)).advanceVaultMovement({
      movementId: settled.movement.id,
      organizationId: ORG,
      toStatus: "confirmed",
      confirmedAt: new Date(0).toISOString(),
    });

    const open = (await (await listDeposits("?settled=false")).json()) as {
      data: { deposits: Array<{ movementId: string; status: string }> };
    };
    expect(open.data.deposits.map((deposit) => deposit.movementId)).toEqual([inFlight.movement.id]);

    const closed = (await (await listDeposits("?settled=true")).json()) as {
      data: { deposits: Array<{ movementId: string }> };
    };
    expect(closed.data.deposits.map((deposit) => deposit.movementId)).toEqual([
      settled.movement.id,
    ]);
  });

  it("rejects a settled filter that is not a boolean", async () => {
    expect((await listDeposits("?settled=maybe")).status).toBe(400);
  });

  it("hides a movement whose project was deleted", async () => {
    // `project_id` is nullable only through ON DELETE SET NULL, so a null means
    // the owning project is gone — not that the row is readable by every
    // sibling project that happens to share an organization-level wallet.
    const orphaned = await createPosition({ providerReference: "vault_orphaned" });
    await getDb(env)
      .prepare("UPDATE earn_movements SET project_id = NULL WHERE id = ?")
      .bind(orphaned.movement.id)
      .run();

    expect((await getDeposit(orphaned.movement.id)).status).toBe(404);
    const body = (await (await listDeposits()).json()) as {
      data: { deposits: Array<{ movementId: string }> };
    };
    expect(body.data.deposits.map((deposit) => deposit.movementId)).not.toContain(
      orphaned.movement.id
    );
  });

  it("answers empty for a key nobody has used", async () => {
    const body = (await (await listDeposits("?requestId=never-used")).json()) as {
      data: { deposits: unknown[] };
    };
    expect(body.data.deposits).toEqual([]);
  });
});
