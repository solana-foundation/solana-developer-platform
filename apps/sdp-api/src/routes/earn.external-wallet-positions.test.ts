import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  type EarnPositionRow,
  generateEarnMovementId,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { collectAllExternalWalletPositionRows } from "@/routes/earn/handlers/external-wallet";
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

const ORG = "org_external_position_reads";
const PROJECT = "prj_external_position_reads";
const USER = "usr_external_position_reads";
const KEY = { id: "key_external_position_reads", raw: "sk_test_external_position_reads" };
const OWNER_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OWNER_B = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SHARE = "So11111111111111111111111111111111111111112";

function cachedKey(): CachedApiKey {
  return {
    id: KEY.id,
    organizationId: ORG,
    projectId: PROJECT,
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

async function seedScope() {
  const keyHash = await hashString(KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, cachedKey());
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "External positions", "external-positions", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "external-positions@example.com"),
    getDb(env)
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'External positions', 'external-positions', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, USER),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'External positions', 'sk_test_ext', ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(KEY.id, ORG, PROJECT, USER, keyHash),
  ]);
}

async function seedPosition(input: {
  ownerAddress: string;
  vaultAddress: string;
  tokenMint: string;
  label: string;
  organizationId?: string;
  projectId?: string;
}) {
  const organizationId = input.organizationId ?? ORG;
  const projectId = input.projectId ?? PROJECT;
  const positionId = generateEarnPositionId();
  const movementId = generateEarnMovementId();
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           owner_address, vault_address, share_mint, token_mint, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, ?, sdp_iso_now())`
      )
      .bind(
        positionId,
        organizationId,
        projectId,
        input.ownerAddress,
        input.vaultAddress,
        SHARE,
        input.tokenMint,
        input.label
      ),
    getDb(env)
      .prepare(
        `INSERT INTO earn_movements (
           id, organization_id, project_id, environment, provider, execution_model,
           direction, position_id, status, denomination, amount_requested,
           owner_address, vault_address, source_address, destination_address,
           signature, signed_transaction, last_valid_block_height, request_id,
           idempotency_fingerprint
         ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', 'deposit', ?,
                   'requested', ?, '1', ?, ?, ?, ?, ?, 'AQ==', '12345', ?, ?)`
      )
      .bind(
        movementId,
        organizationId,
        projectId,
        positionId,
        input.tokenMint,
        input.ownerAddress,
        input.vaultAddress,
        input.ownerAddress,
        input.vaultAddress,
        `sig_${crypto.randomUUID()}`,
        crypto.randomUUID(),
        `fingerprint_${positionId}`
      ),
  ]);
  return positionId;
}

function get(path: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${KEY.raw}` } }, env);
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
        tokenValue:
          providerReference === "vault-usdt" ? "5.5" : input.owner === OWNER_A ? "10.1" : "20.2",
        tokenMint: providerReference === "vault-usdt" ? USDT : USDC,
        shareMint: SHARE,
      }))
  );
});

describe("external-wallet position reads", () => {
  it("returns complete exact-decimal totals across wallets by strategy and token", async () => {
    await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    await seedPosition({
      ownerAddress: OWNER_B,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    await seedPosition({
      ownerAddress: OWNER_B,
      vaultAddress: "vault-usdt",
      tokenMint: USDT,
      label: "USDT vault",
    });

    const response = await get("/v1/earn/external-wallet/positions/summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { summary: Record<string, unknown> } };

    expect(body.data.summary).toMatchObject({
      walletCount: 2,
      positionCount: 3,
      unavailablePositionCount: 0,
      totalsByToken: [
        { tokenMint: USDC, walletCount: 2, positionCount: 2, tokenValue: "30.3" },
        { tokenMint: USDT, walletCount: 1, positionCount: 1, tokenValue: "5.5" },
      ],
      totalsByStrategy: [
        {
          label: "USDC vault",
          ownerAddresses: [OWNER_A, OWNER_B].sort(),
          walletCount: 2,
          positionCount: 2,
          totalsByToken: [{ tokenMint: USDC, tokenValue: "30.3" }],
        },
        {
          label: "USDT vault",
          ownerAddresses: [OWNER_B],
          walletCount: 1,
          positionCount: 1,
          totalsByToken: [{ tokenMint: USDT, tokenValue: "5.5" }],
        },
      ],
    });
    expect(resolveVaultDirectClient).toHaveBeenCalledTimes(2);
    expect(resolveVaultDirectClient.mock.calls[0]?.[2]).not.toBe(
      resolveVaultDirectClient.mock.calls[1]?.[2]
    );
  });

  it("returns exactly one wallet and leaves an unreadable live value unavailable", async () => {
    await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-readable",
      tokenMint: USDC,
      label: "Readable",
    });
    await seedPosition({
      ownerAddress: OWNER_B,
      vaultAddress: "vault-unreadable",
      tokenMint: USDC,
      label: "Unreadable",
    });
    readVaultPositions.mockImplementation(
      async (_ctx, input: { owner: string; providerReferences: string[] }) => {
        if (input.owner === OWNER_B) throw new Error("RPC unavailable");
        return input.providerReferences.map((providerReference) => ({
          providerReference,
          owner: input.owner,
          cluster: "devnet",
          shares: "7",
          withdrawableShares: "6",
          tokenValue: "7.25",
          tokenMint: USDC,
          shareMint: SHARE,
        }));
      }
    );

    const response = await get(`/v1/earn/external-wallet/positions?ownerAddress=${OWNER_B}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { positions: Array<Record<string, unknown>> } };
    expect(body.data.positions).toHaveLength(1);
    expect(body.data.positions[0]).toMatchObject({ ownerAddress: OWNER_B, label: "Unreadable" });
    expect(body.data.positions[0]).not.toHaveProperty("tokenValue");
    expect(body.data.positions[0]).not.toHaveProperty("shares");

    const summary = (await (await get("/v1/earn/external-wallet/positions/summary")).json()) as {
      data: {
        summary: {
          unavailablePositionCount: number;
          totalsByToken: Array<Record<string, unknown>>;
        };
      };
    };
    expect(summary.data.summary.unavailablePositionCount).toBe(1);
    expect(summary.data.summary.totalsByToken[0]).not.toHaveProperty("tokenValue");
  });

  it("404s an owner whose claim belongs to another organization", async () => {
    const foreignOrg = "org_external_position_foreign";
    const foreignProject = "prj_external_position_foreign";
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(foreignOrg, "Foreign", "external-position-foreign", "enterprise", "active"),
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Foreign', 'external-position-foreign', 'sandbox', 'active', ?)`
        )
        .bind(foreignProject, foreignOrg, USER),
    ]);
    await seedPosition({
      ownerAddress: OWNER_B,
      vaultAddress: "vault-foreign",
      tokenMint: USDC,
      label: "Foreign",
      organizationId: foreignOrg,
      projectId: foreignProject,
    });

    expect((await get(`/v1/earn/external-wallet/positions?ownerAddress=${OWNER_B}`)).status).toBe(
      404
    );
  });

  it.each(["&limit=0", "&limit=101", "&before=not-a-cursor", "&page=2"])(
    "strictly rejects malformed or unknown per-wallet query %s",
    async (query) => {
      await seedPosition({
        ownerAddress: OWNER_A,
        vaultAddress: "vault-query",
        tokenMint: USDC,
        label: "Query",
      });
      expect(
        (await get(`/v1/earn/external-wallet/positions?ownerAddress=${OWNER_A}${query}`)).status
      ).toBe(400);
    }
  );

  it("keeps the retired path-addressed shape dead", async () => {
    // PRO-1722 originally addressed the owner as a path segment; the surface
    // unified on the movements list's query addressing before GA. A base58
    // segment must read as an unknown route, never as an owner.
    await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-retired",
      tokenMint: USDC,
      label: "Retired",
    });
    expect((await get(`/v1/earn/external-wallet/positions/${OWNER_A}`)).status).toBe(404);
    expect((await get(`/v1/earn/external-wallet/earnings/${OWNER_A}`)).status).toBe(404);
    // The query-addressed replacements answer for the same owner, so the 404s
    // above assert the SHAPE is gone rather than the data.
    expect((await get(`/v1/earn/external-wallet/positions?ownerAddress=${OWNER_A}`)).status).toBe(
      200
    );
  });

  it("fails loudly when a keyset reader repeats its bound", async () => {
    const row = {
      id: "earn_position_repeat",
      created_at: "2026-08-28T00:00:00.000Z",
    } as EarnPositionRow;
    await expect(
      collectAllExternalWalletPositionRows(async () => ({ rows: [row], hasMore: true }))
    ).rejects.toThrow("pagination did not advance");
  });

  it("fails loudly when a keyset reader moves its bound backwards", async () => {
    const rows = [
      { id: "earn_position_first", created_at: "2026-08-27T00:00:00.000Z" },
      { id: "earn_position_later", created_at: "2026-08-28T00:00:00.000Z" },
    ] as EarnPositionRow[];
    let page = 0;
    await expect(
      collectAllExternalWalletPositionRows(async () => ({
        rows: [rows[page++] as EarnPositionRow],
        hasMore: true,
      }))
    ).rejects.toThrow("pagination did not advance");
  });

  it("continues past one hundred pages until the keyset reader is complete", async () => {
    let page = 0;
    const rows = await collectAllExternalWalletPositionRows(async () => {
      const current = page;
      page += 1;
      return {
        rows: [
          {
            id: `earn_position_${String(200 - current).padStart(3, "0")}`,
            created_at: "2026-08-28T00:00:00.000Z",
          } as EarnPositionRow,
        ],
        hasMore: current < 100,
      };
    });

    expect(rows).toHaveLength(101);
    expect(page).toBe(101);
  });
});
