import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnVaultRepository } from "@/db/repositories/earn-vault.repository";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const readVaultPositions = vi.hoisted(() => vi.fn());

vi.mock("@/services/earn/execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/execution-registry")>()),
  resolveVaultDirectClient: () => ({ readVaultPositions }),
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
  return createPostgresEarnVaultRepository(getDb(env)).createSignedDepositIntent({
    organizationId: ORG,
    projectId: params.projectId ?? PROJECT_A,
    environment: "sandbox",
    provider: "kamino",
    providerReference,
    custodyWalletId: walletId,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    label: `Vault ${providerReference}`,
    requestedAmount: "1",
    acceptedAmount: "1",
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

  it.each([
    ["owner", { owner: PUBLIC_KEY_B }],
    ["amount", { shares: "NaN" }],
  ] as const)("does not attach live balances under a mismatched %s", async (kind, override) => {
    const providerReference = `vault_${kind}_mismatch`;
    await createPosition({ providerReference });
    readVaultPositions.mockResolvedValue([
      {
        providerReference,
        owner: PUBLIC_KEY_A,
        cluster: "devnet",
        shares: "99",
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
    ["malformed position id", "2026-08-17T16:29:31.000Z", "not-a-position-id"],
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
