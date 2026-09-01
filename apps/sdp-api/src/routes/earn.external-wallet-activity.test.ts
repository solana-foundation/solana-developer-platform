import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  generateEarnMovementId,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
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

/**
 * The B2B2C activity and earnings reads (PRO-1772): the loop-closing half of
 * the external-wallet surface. The API key here holds ONLY `earn:read` — that
 * these routes need no `wallets:read` is a ticket acceptance criterion, not an
 * accident of the fixture.
 */

const ORG = "org_external_activity";
const PROJECT = "prj_external_activity";
const SIBLING_PROJECT = "prj_external_activity_sibling";
const USER = "usr_external_activity";
const KEY = { id: "key_external_activity", raw: "sk_test_external_activity" };
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
    role: "api_developer",
    permissions: ["earn:read"],
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
      .bind(ORG, "External activity", "external-activity", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "external-activity@example.com"),
    getDb(env)
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'External activity', 'external-activity', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, USER),
    getDb(env)
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Sibling', 'external-activity-sibling', 'sandbox', 'active', ?)`
      )
      .bind(SIBLING_PROJECT, ORG, USER),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'External activity', 'sk_test_act', ?, 'api_developer', '["earn:read"]', 'active')`
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
  /** A fully exited holding; the position lists exclude it absent a re-entry. */
  closedAt?: string;
}): Promise<string> {
  const positionId = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         owner_address, vault_address, share_mint, token_mint, label, activated_at, closed_at
       ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, ?, sdp_iso_now(), ?)`
    )
    .bind(
      positionId,
      input.organizationId ?? ORG,
      input.projectId ?? PROJECT,
      input.ownerAddress,
      input.vaultAddress,
      SHARE,
      input.tokenMint,
      input.label,
      input.closedAt ?? null
    )
    .run();
  return positionId;
}

/**
 * One vault movement with valid 0062 commitment metadata for its status:
 * confirmed/finalized stamp `confirmed_at`, finalized stamps `settled_at` and
 * `amount_settled`, failed stamps `failure_reason`.
 */
async function seedMovement(input: {
  positionId: string;
  ownerAddress: string;
  vaultAddress: string;
  direction: "deposit" | "withdrawal";
  status: "requested" | "submitted" | "confirmed" | "finalized" | "failed";
  amount: string;
  denomination: string;
  createdAt: string;
  organizationId?: string;
  projectId?: string;
}): Promise<string> {
  const movementId = generateEarnMovementId();
  const confirmedAt =
    input.status === "confirmed" || input.status === "finalized" ? input.createdAt : null;
  const settledAt = input.status === "finalized" ? input.createdAt : null;
  const amountSettled = input.status === "finalized" ? input.amount : null;
  const failureReason = input.status === "failed" ? "expired unlanded" : null;
  const [source, destination] =
    input.direction === "deposit"
      ? [input.ownerAddress, input.vaultAddress]
      : [input.vaultAddress, input.ownerAddress];
  await getDb(env)
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider, execution_model,
         direction, position_id, status, denomination, amount_requested, amount_settled,
         owner_address, vault_address, source_address, destination_address,
         signature, signed_transaction, last_valid_block_height, request_id,
         idempotency_fingerprint, created_at, confirmed_at, settled_at, failure_reason
       ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, 'AQ==', '12345', ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      movementId,
      input.organizationId ?? ORG,
      input.projectId ?? PROJECT,
      input.direction,
      input.positionId,
      input.status,
      input.denomination,
      input.amount,
      amountSettled,
      input.ownerAddress,
      input.vaultAddress,
      source,
      destination,
      `sig_${crypto.randomUUID()}`,
      crypto.randomUUID(),
      `fingerprint_${movementId}`,
      input.createdAt,
      confirmedAt,
      settledAt,
      failureReason
    )
    .run();
  return movementId;
}

function get(path: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${KEY.raw}` } }, env);
}

function liveValue(values: Record<string, string | undefined>) {
  readVaultPositions.mockImplementation(
    async (_ctx: unknown, input: { owner: string; providerReferences: string[] }) =>
      input.providerReferences.map((providerReference) => ({
        providerReference,
        owner: input.owner,
        cluster: "devnet",
        shares: "1",
        withdrawableShares: "1",
        tokenValue: values[providerReference],
        tokenMint: providerReference.includes("usdt") ? USDT : USDC,
        shareMint: SHARE,
      }))
  );
}

beforeEach(async () => {
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
  await clearKVStores(env);
  await seedScope();
  vi.clearAllMocks();
  liveValue({});
});

describe("external-wallet activity", () => {
  it("lists one owner's movements newest first in ledger vocabulary, without wallets:read", async () => {
    const position = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    const base = { positionId: position, ownerAddress: OWNER_A, vaultAddress: "vault-usdc" };
    await seedMovement({
      ...base,
      direction: "deposit",
      status: "finalized",
      amount: "60",
      denomination: USDC,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    await seedMovement({
      ...base,
      direction: "deposit",
      status: "failed",
      amount: "5",
      denomination: USDC,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    const withdrawalId = await seedMovement({
      ...base,
      direction: "withdrawal",
      status: "finalized",
      amount: "3",
      denomination: SHARE,
      createdAt: "2026-08-29T00:00:00.000Z",
    });

    const response = await get(`/v1/earn/external-wallet/movements?ownerAddress=${OWNER_A}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        ownerAddress: string;
        movements: Array<Record<string, unknown>>;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };
    expect(body.data.ownerAddress).toBe(OWNER_A);
    expect(body.data.hasMore).toBe(false);
    expect(body.data.movements.map((movement) => movement.status)).toEqual([
      "finalized",
      "failed",
      "finalized",
    ]);
    expect(body.data.movements[0]).toMatchObject({
      movementId: withdrawalId,
      positionId: position,
      direction: "withdrawal",
      amount: "3",
      denomination: SHARE,
      ownerAddress: OWNER_A,
      providerReference: "vault-usdc",
    });
    expect(body.data.movements[0]).toHaveProperty("signature");
    // A stored row cannot say how it was asked for: replayed is POST-only.
    expect(body.data.movements[0]).not.toHaveProperty("replayed");

    const deposits = (await (
      await get(`/v1/earn/external-wallet/movements?ownerAddress=${OWNER_A}&direction=deposit`)
    ).json()) as { data: { movements: Array<Record<string, unknown>> } };
    expect(deposits.data.movements).toHaveLength(2);

    const finalized = (await (
      await get(`/v1/earn/external-wallet/movements?ownerAddress=${OWNER_A}&status=finalized`)
    ).json()) as { data: { movements: Array<Record<string, unknown>> } };
    expect(finalized.data.movements).toHaveLength(2);
  });

  it("pages with a keyset cursor and never overlaps, including same-instant rows", async () => {
    const position = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    // Two rows share one created_at on purpose: a same-instant batch is where
    // a cursor without the id tie-break would skip or repeat a row.
    for (const [index, createdAt] of [
      "2026-08-27T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
    ].entries()) {
      await seedMovement({
        positionId: position,
        ownerAddress: OWNER_A,
        vaultAddress: "vault-usdc",
        direction: "deposit",
        status: "finalized",
        amount: `${index + 1}`,
        denomination: USDC,
        createdAt,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor
        ? `ownerAddress=${OWNER_A}&limit=1&before=${encodeURIComponent(cursor)}`
        : `ownerAddress=${OWNER_A}&limit=1`;
      const page = (await (await get(`/v1/earn/external-wallet/movements?${query}`)).json()) as {
        data: { movements: Array<{ movementId: string }>; nextCursor: string | null };
      };
      seen.push(...page.data.movements.map((movement) => movement.movementId));
      cursor = page.data.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it.each([
    `?ownerAddress=${OWNER_A}&before=not-a-cursor`,
    `?ownerAddress=${OWNER_A}&limit=0`,
    `?ownerAddress=${OWNER_A}&limit=101`,
    `?ownerAddress=${OWNER_A}&page=2`,
    "?direction=deposit",
    "?ownerAddress=not-an-address",
  ])("strictly rejects a malformed movements query %s", async (query) => {
    await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    expect((await get(`/v1/earn/external-wallet/movements${query}`)).status).toBe(400);
  });

  it("scopes the list to the exact project and 404s a foreign organization's owner", async () => {
    const position = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "deposit",
      status: "finalized",
      amount: "60",
      denomination: USDC,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    // The same owner also moved money through a SIBLING project: a different
    // integration surface, invisible here by the 0070 claim scope.
    const siblingPosition = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-sibling",
      tokenMint: USDC,
      label: "Sibling vault",
      projectId: SIBLING_PROJECT,
    });
    const siblingMovement = await seedMovement({
      positionId: siblingPosition,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-sibling",
      direction: "deposit",
      status: "finalized",
      amount: "999",
      denomination: USDC,
      createdAt: "2026-08-30T00:00:00.000Z",
      projectId: SIBLING_PROJECT,
    });

    const body = (await (
      await get(`/v1/earn/external-wallet/movements?ownerAddress=${OWNER_A}`)
    ).json()) as { data: { movements: Array<{ providerReference: string }> } };
    expect(body.data.movements).toHaveLength(1);
    expect(body.data.movements[0]?.providerReference).toBe("vault-usdc");

    // The sibling row is not addressable by id either.
    expect((await get(`/v1/earn/external-wallet/movements/${siblingMovement}`)).status).toBe(404);

    // An owner only a foreign organization has claimed reads as never seen.
    const foreignOrg = "org_external_activity_foreign";
    const foreignProject = "prj_external_activity_foreign";
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(foreignOrg, "Foreign", "external-activity-foreign", "enterprise", "active"),
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Foreign', 'external-activity-foreign', 'sandbox', 'active', ?)`
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
    expect((await get(`/v1/earn/external-wallet/movements?ownerAddress=${OWNER_B}`)).status).toBe(
      404
    );
    expect((await get(`/v1/earn/external-wallet/earnings/${OWNER_B}`)).status).toBe(404);
  });

  it("serves one movement by id and 404s a custody-signed row", async () => {
    const position = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    const movementId = await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "deposit",
      status: "submitted",
      amount: "60",
      denomination: USDC,
      createdAt: "2026-08-27T00:00:00.000Z",
    });

    const response = await get(`/v1/earn/external-wallet/movements/${movementId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { movement: Record<string, unknown> } };
    expect(body.data.movement).toMatchObject({
      movementId,
      status: "submitted",
      direction: "deposit",
      ownerAddress: OWNER_A,
    });

    // A custody-signed vault movement is not an external-wallet movement, and a
    // guessed id answers exactly like a missing row.
    const custodyPositionId = generateEarnPositionId();
    const custodyMovementId = generateEarnMovementId();
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, status)
           VALUES ('ccfg_external_activity', ?, ?, 'privy', 'encrypted', 'active')`
        )
        .bind(ORG, PROJECT),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES ('cwlt_external_activity', 'ccfg_external_activity', 'privy_external_activity', ?, 'active')`
        )
        .bind(OWNER_B),
      getDb(env)
        .prepare(
          `INSERT INTO earn_positions (
             id, organization_id, project_id, environment, provider, kind,
             custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at
           ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', 'cwlt_external_activity',
                     'vault-custody', ?, ?, 'Custody', sdp_iso_now())`
        )
        .bind(custodyPositionId, ORG, PROJECT, SHARE, USDC),
      getDb(env)
        .prepare(
          `INSERT INTO earn_movements (
             id, organization_id, project_id, environment, provider, execution_model,
             direction, position_id, status, denomination, amount_requested,
             custody_wallet_id, vault_address, source_address, destination_address,
             signature, signed_transaction, last_valid_block_height, request_id,
             idempotency_fingerprint
           ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', 'deposit', ?, 'submitted',
                     ?, '10', 'cwlt_external_activity', 'vault-custody', ?, 'vault-custody',
                     ?, 'AQ==', '12345', ?, ?)`
        )
        .bind(
          custodyMovementId,
          ORG,
          PROJECT,
          custodyPositionId,
          USDC,
          OWNER_B,
          `sig_${crypto.randomUUID()}`,
          crypto.randomUUID(),
          `fingerprint_${custodyMovementId}`
        ),
    ]);
    expect((await get(`/v1/earn/external-wallet/movements/${custodyMovementId}`)).status).toBe(404);
    expect((await get("/v1/earn/external-wallet/movements/earn_movement_missing")).status).toBe(
      404
    );
  });
});

describe("external-wallet earnings", () => {
  it("states earned per token exactly, including a negative figure", async () => {
    const usdcOne = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc-one",
      tokenMint: USDC,
      label: "USDC one",
    });
    const usdcTwo = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc-two",
      tokenMint: USDC,
      label: "USDC two",
    });
    const usdt = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdt",
      tokenMint: USDT,
      label: "USDT",
    });
    for (const [position, vault, amount] of [
      [usdcOne, "vault-usdc-one", "60"],
      [usdcTwo, "vault-usdc-two", "40"],
      [usdt, "vault-usdt", "10"],
    ] as const) {
      await seedMovement({
        positionId: position,
        ownerAddress: OWNER_A,
        vaultAddress: vault,
        direction: "deposit",
        status: "finalized",
        amount,
        denomination: vault === "vault-usdt" ? USDT : USDC,
        createdAt: "2026-08-27T00:00:00.000Z",
      });
    }
    liveValue({ "vault-usdc-one": "66", "vault-usdc-two": "44.5", "vault-usdt": "9" });

    const response = await get(`/v1/earn/external-wallet/earnings/${OWNER_A}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { earnings: Record<string, unknown> } };
    expect(body.data.earnings).toMatchObject({
      ownerAddress: OWNER_A,
      positionCount: 3,
      unavailablePositionCount: 0,
      totalsByToken: [
        {
          tokenMint: USDC,
          positionCount: 2,
          unavailablePositionCount: 0,
          currentValue: "110.5",
          totalDeposited: "100",
          earned: "10.5",
        },
        {
          tokenMint: USDT,
          positionCount: 1,
          currentValue: "9",
          totalDeposited: "10",
          earned: "-1",
        },
      ],
    });
  });

  it("reports earned unavailable, never zero, when live value cannot hydrate", async () => {
    const position = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "deposit",
      status: "finalized",
      amount: "60",
      denomination: USDC,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    readVaultPositions.mockRejectedValue(new Error("RPC unavailable"));

    const body = (await (await get(`/v1/earn/external-wallet/earnings/${OWNER_A}`)).json()) as {
      data: {
        earnings: {
          unavailablePositionCount: number;
          totalsByToken: Array<Record<string, unknown>>;
        };
      };
    };
    expect(body.data.earnings.unavailablePositionCount).toBe(1);
    const token = body.data.earnings.totalsByToken[0];
    expect(token).toMatchObject({
      tokenMint: USDC,
      totalDeposited: "60",
      earnedUnavailableReason: "live_value_unavailable",
    });
    expect(token).not.toHaveProperty("earned");
    expect(token).not.toHaveProperty("currentValue");
  });

  it("withholds earned while a movement is still settling", async () => {
    const position = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "deposit",
      status: "finalized",
      amount: "60",
      denomination: USDC,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "deposit",
      status: "submitted",
      amount: "40",
      denomination: USDC,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    liveValue({ "vault-usdc": "61" });

    const body = (await (await get(`/v1/earn/external-wallet/earnings/${OWNER_A}`)).json()) as {
      data: { earnings: { totalsByToken: Array<Record<string, unknown>> } };
    };
    const token = body.data.earnings.totalsByToken[0];
    // The settling deposit is not yet a finalized ledger fact, and the live
    // value may or may not include it — so earned is withheld, not guessed.
    expect(token).toMatchObject({
      currentValue: "61",
      totalDeposited: "60",
      earnedUnavailableReason: "movements_pending",
    });
    expect(token).not.toHaveProperty("earned");
  });

  it("withholds earned once a withdrawal exists, because exits are ledgered in shares", async () => {
    const position = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "deposit",
      status: "finalized",
      amount: "60",
      denomination: USDC,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "withdrawal",
      status: "finalized",
      amount: "3",
      denomination: SHARE,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    liveValue({ "vault-usdc": "58" });

    const body = (await (await get(`/v1/earn/external-wallet/earnings/${OWNER_A}`)).json()) as {
      data: { earnings: { totalsByToken: Array<Record<string, unknown>> } };
    };
    const token = body.data.earnings.totalsByToken[0];
    expect(token).toMatchObject({
      currentValue: "58",
      totalDeposited: "60",
      earnedUnavailableReason: "withdrawals_not_valued",
    });
    expect(token).not.toHaveProperty("earned");
  });

  it("scopes earned to current holdings: a fully exited vault's history drops out", async () => {
    // Owner fully exited vault A (finalized deposit + withdrawal, position
    // closed) and holds open vault B in the SAME token. Earned is stated
    // exactly from B alone: A's deposits leave totalDeposited along with its
    // unvalued withdrawal, so the figure stays internally consistent over
    // what the wallet currently holds. Consuming A's history instead would
    // report withdrawals_not_valued forever after any full exit. Pinned so a
    // refactor cannot change the semantic silently (ADR 0002, 2026-08-31).
    const exited = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc-exited",
      tokenMint: USDC,
      label: "Exited",
      closedAt: "2026-08-28T00:00:00.000Z",
    });
    await seedMovement({
      positionId: exited,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc-exited",
      direction: "deposit",
      status: "finalized",
      amount: "60",
      denomination: USDC,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    await seedMovement({
      positionId: exited,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc-exited",
      direction: "withdrawal",
      status: "finalized",
      amount: "60",
      denomination: SHARE,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    const open = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc-open",
      tokenMint: USDC,
      label: "Open",
    });
    await seedMovement({
      positionId: open,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc-open",
      direction: "deposit",
      status: "finalized",
      amount: "40",
      denomination: USDC,
      createdAt: "2026-08-29T00:00:00.000Z",
    });
    liveValue({ "vault-usdc-open": "44" });

    const body = (await (await get(`/v1/earn/external-wallet/earnings/${OWNER_A}`)).json()) as {
      data: { earnings: Record<string, unknown> };
    };
    expect(body.data.earnings).toMatchObject({
      positionCount: 1,
      totalsByToken: [
        {
          tokenMint: USDC,
          positionCount: 1,
          totalDeposited: "40",
          currentValue: "44",
          earned: "4",
        },
      ],
    });
    // The exited vault's movements stay fully visible on the activity feed.
    const activity = (await (
      await get(`/v1/earn/external-wallet/movements?ownerAddress=${OWNER_A}`)
    ).json()) as { data: { movements: Array<Record<string, unknown>> } };
    expect(activity.data.movements).toHaveLength(3);
  });

  it("ignores failed movements entirely", async () => {
    const position = await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "deposit",
      status: "finalized",
      amount: "60",
      denomination: USDC,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    await seedMovement({
      positionId: position,
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      direction: "deposit",
      status: "failed",
      amount: "40",
      denomination: USDC,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    liveValue({ "vault-usdc": "66" });

    const body = (await (await get(`/v1/earn/external-wallet/earnings/${OWNER_A}`)).json()) as {
      data: { earnings: { totalsByToken: Array<Record<string, unknown>> } };
    };
    expect(body.data.earnings.totalsByToken[0]).toMatchObject({
      totalDeposited: "60",
      currentValue: "66",
      earned: "6",
    });
  });

  it.each(["?limit=1", "?page=2"])("rejects unknown earnings query %s", async (query) => {
    await seedPosition({
      ownerAddress: OWNER_A,
      vaultAddress: "vault-usdc",
      tokenMint: USDC,
      label: "USDC vault",
    });
    expect((await get(`/v1/earn/external-wallet/earnings/${OWNER_A}${query}`)).status).toBe(400);
  });
});
