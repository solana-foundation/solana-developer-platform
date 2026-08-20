import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

/**
 * GET /v1/earn/movements — the cross-provider feed (PRO-1705).
 *
 * Two things need proving. That it actually unifies: one chronological list
 * carrying both execution models, in the ledger's own vocabulary. And that it
 * does not LEAK: a new read over a table that now holds every movement is the
 * obvious place for a scoping rule to go missing, so every boundary the
 * per-family reads enforce is asserted here too.
 */

const ORG = "org_earn_feed";
const ORG_OTHER = "org_earn_feed_other";
const USER = "usr_earn_feed";
const PROJECT_A = "prj_earn_feed_a";
const PROJECT_B = "prj_earn_feed_b";
const CONFIG_A = "cfg_earn_feed_a";
const CONFIG_B = "cfg_earn_feed_b";
const WALLET_A = "cwlt_earn_feed_a";
const WALLET_B = "cwlt_earn_feed_b";
// An ORGANIZATION-level config, so this wallet is reachable from PROJECT_A —
// which is what makes the API-key wallet binding the only thing that can
// exclude its movements.
const CONFIG_ORG = "cfg_earn_feed_org";
const WALLET_ORG = "cwlt_earn_feed_org";
const PUBLIC_KEY_ORG = "6dNVeCP6YQ9GDDLLQrNqzKPfSHfmybEqMcaWEqMTBRvR";
const PUBLIC_KEY_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PUBLIC_KEY_B = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "VaultFeedAddress1111111111111111111111111111";
const PAYOUT = "PayoutFeedAddress111111111111111111111111111";
const API_KEY = { id: "key_earn_feed", raw: "sk_test_earn_feed" };

interface MovementJson {
  id: string;
  executionModel: string;
  direction: string;
  status: string;
  denomination: string;
  amountRequested: string;
  vaultAddress?: string;
  sourceAddress?: string;
  destinationAddress?: string;
  payoutToken?: string;
  signature?: string;
  positionId: string;
  settledAt?: string;
}

/**
 * `walletScope` is resolved from the CACHED key, not from a DB row — so a test
 * that only inserts into `api_key_wallet_permissions` changes nothing. Seeding a
 * `selected` key is the only way to exercise the binding, and the ids it carries
 * are PROVIDER wallet ids (`privy_…`), not `custody_wallets` row ids (`cwlt_…`).
 */
function cachedKey(
  binding: { walletScope: "selected"; signingWalletIds: string[] } | null = null
): CachedApiKey {
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
    ...(binding ?? {}),
  };
}

/**
 * Bind the key to specific wallets, which takes BOTH halves.
 *
 * `hasSelectedWalletScope` reads the CACHED key, while the allowed set is built
 * from `walletBindings`, which the auth middleware loads from
 * `api_key_wallet_permissions`. Seeding only the cache leaves the allowed set
 * empty and hides every vault movement; seeding only the rows leaves the scope
 * `all` and hides nothing. Either half alone is a test that proves nothing.
 */
async function bindKeyToWallets(providerWalletIds: string[]): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(
    env,
    keyHash,
    cachedKey({ walletScope: "selected", signingWalletIds: providerWalletIds })
  );
  for (const providerWalletId of providerWalletIds) {
    await getDb(env)
      .prepare(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES (?, ?, ?, '["*"]')`
      )
      .bind(`akwp_${crypto.randomUUID()}`, API_KEY.id, providerWalletId)
      .run();
  }
}

async function seedScope(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, cachedKey());
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Earn Feed", "earn-feed", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_OTHER, "Earn Feed Other", "earn-feed-other", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "earn-feed@example.com"),
    ...[PROJECT_A, PROJECT_B].map((projectId, index) =>
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, ORG, `Feed ${index}`, `earn-feed-${index}`, USER)
    ),
    getDb(env)
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES ('prj_earn_feed_prod', ?, 'Feed Prod', 'earn-feed-prod', 'production', 'active', ?)`
      )
      .bind(ORG, USER),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'api_admin', '["*"]'::jsonb, 'active')`
      )
      .bind(API_KEY.id, ORG, PROJECT_A, USER, "Feed key", "sk_test_ear", keyHash),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, NULL, 'privy', 'encrypted', 'active')`
      )
      .bind(CONFIG_ORG, ORG),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'privy_feed_org', ?, 'active')`
      )
      .bind(WALLET_ORG, CONFIG_ORG, PUBLIC_KEY_ORG),
    ...[
      [CONFIG_A, PROJECT_A, WALLET_A, "privy_feed_a", PUBLIC_KEY_A],
      [CONFIG_B, PROJECT_B, WALLET_B, "privy_feed_b", PUBLIC_KEY_B],
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

async function seedVaultDeposit(
  overrides: { projectId?: string; walletId?: string; vault?: string; amount?: string } = {}
) {
  return createPostgresEarnMovementsRepository(getDb(env)).createSignedVaultDepositIntent({
    organizationId: ORG,
    projectId: overrides.projectId ?? PROJECT_A,
    environment: "sandbox",
    provider: "kamino",
    vaultAddress: overrides.vault ?? VAULT,
    custodyWalletId: overrides.walletId ?? WALLET_A,
    sourceAddress: PUBLIC_KEY_A,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    label: "USDC vault",
    requestedAmount: overrides.amount ?? "10",
    signature: `sig_${crypto.randomUUID()}`,
    signedTransaction: "AQ==",
    lastValidBlockHeight: "12345",
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: `fp_${crypto.randomUUID()}`,
    createdBy: USER,
  });
}

async function seedProgramWithdrawal(overrides: { amountUsd?: string } = {}) {
  const repo = createPostgresEarnRepository(getDb(env));
  const wallet = await repo.insertProviderWallet({
    organizationId: ORG,
    projectId: PROJECT_A,
    environment: "sandbox",
    provider: "veda" as never,
    providerWalletRef: `gw_${crypto.randomUUID()}`,
    label: "Treasury program",
    createdBy: USER,
  });
  if (!wallet) throw new Error("program wallet not linked");
  const withdrawal = await createPostgresEarnMovementsRepository(
    getDb(env)
  ).createCustodialMovement({
    organizationId: ORG,
    projectId: PROJECT_A,
    providerWalletId: wallet.id,
    environment: "sandbox",
    provider: "veda" as never,
    amountRequestedUsd: overrides.amountUsd ?? "500.25",
    payoutToken: "usdc",
    destinationAddress: PAYOUT,
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: `fp_${crypto.randomUUID()}`,
    providerData: {},
    createdBy: USER,
    initiatedByKeyId: null,
  });
  if (!withdrawal) throw new Error("withdrawal not created");
  return { wallet, withdrawal };
}

/**
 * Write a vault movement STRAIGHT to the ledger.
 *
 * For the cross-organization and cross-environment cases only: the writers derive
 * both from the project, and the movement's tenancy foreign key requires its
 * holding to agree, so neither state can be reached by mutating a real row after
 * the fact. Written as a matched pair so the ONLY thing that differs is the
 * boundary under test.
 */
async function seedForeignLedgerMovement(overrides: {
  organizationId: string;
  environment: "sandbox" | "production";
  vault: string;
}): Promise<string> {
  const positionId = `earn_position_${crypto.randomUUID()}`;
  const movementId = `earn_vault_movement_${crypto.randomUUID()}`;
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO earn_positions
           (id, organization_id, project_id, environment, provider, kind,
            custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at)
         VALUES (?, ?, NULL, ?, 'kamino', 'vault_direct', ?, ?, ?, ?, 'Foreign vault', sdp_iso_now())`
      )
      .bind(
        positionId,
        overrides.organizationId,
        overrides.environment,
        WALLET_A,
        overrides.vault,
        SHARE_MINT,
        TOKEN_MINT
      ),
    getDb(env)
      .prepare(
        `INSERT INTO earn_movements
           (id, organization_id, project_id, environment, provider, execution_model,
            direction, position_id, status, denomination, amount_requested,
            custody_wallet_id, vault_address, signature, signed_transaction,
            last_valid_block_height, request_id, idempotency_fingerprint)
         VALUES (?, ?, NULL, ?, 'kamino', 'vault_direct', 'deposit', ?, 'requested',
                 ?, '1', ?, ?, ?, 'AQ==', 12345, ?, ?)`
      )
      .bind(
        movementId,
        overrides.organizationId,
        overrides.environment,
        positionId,
        TOKEN_MINT,
        WALLET_A,
        overrides.vault,
        `sig_${crypto.randomUUID()}`,
        crypto.randomUUID(),
        `fp_${crypto.randomUUID()}`
      ),
  ]);
  return movementId;
}

function listMovements(query = "") {
  return app.request(
    `/v1/earn/movements${query}`,
    { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
    env
  );
}

async function movementsJson(query = ""): Promise<{
  movements: MovementJson[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const response = await listMovements(query);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { movements: MovementJson[]; hasMore: boolean; nextCursor: string | null };
  };
  return body.data;
}

beforeEach(async () => {
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
  await clearKVStores(env);
  await seedScope();
});

describe("GET /v1/earn/movements", () => {
  it("returns both execution models in one chronological list, each self-describing", async () => {
    const { withdrawal } = await seedProgramWithdrawal({ amountUsd: "500.25" });
    const deposit = await seedVaultDeposit({ amount: "10" });

    const body = await movementsJson();
    expect(body.movements.map((movement) => movement.id)).toEqual([
      deposit.movement.id,
      withdrawal.id,
    ]);

    const vault = body.movements[0];
    expect(vault).toMatchObject({
      executionModel: "vault_direct",
      direction: "deposit",
      // The ledger's own vocabulary, NOT the legacy vault DTO's `pending`: this
      // contract has no existing client to keep compatible.
      status: "requested",
      denomination: TOKEN_MINT,
      amountRequested: "10",
      vaultAddress: VAULT,
      sourceAddress: PUBLIC_KEY_A,
      destinationAddress: VAULT,
    });
    expect(vault.signature).toBeDefined();
    expect(vault.payoutToken).toBeUndefined();

    const custodial = body.movements[1];
    expect(custodial).toMatchObject({
      executionModel: "custodial",
      direction: "withdrawal",
      status: "requested",
      // USD and mint units sit in the same column, and each row says which.
      denomination: "usd",
      amountRequested: "500.25",
      payoutToken: "usdc",
      destinationAddress: PAYOUT,
    });
    expect(custodial.vaultAddress).toBeUndefined();
    expect(custodial.signature).toBeUndefined();
  });

  it("never exposes the signed transaction, fingerprint or caller request id", async () => {
    await seedVaultDeposit();
    const body = await movementsJson();
    const raw = JSON.stringify(body.movements[0]);
    for (const leaked of [
      "signedTransaction",
      "signed_transaction",
      "idempotencyFingerprint",
      "idempotency_fingerprint",
      "requestId",
      "request_id",
      "lastValidBlockHeight",
    ]) {
      expect(raw).not.toContain(leaked);
    }
  });

  it("filters by direction, provider, holding and counterparty address", async () => {
    const { withdrawal } = await seedProgramWithdrawal();
    const deposit = await seedVaultDeposit();

    expect((await movementsJson("?direction=deposit")).movements.map((m) => m.id)).toEqual([
      deposit.movement.id,
    ]);
    expect((await movementsJson("?direction=withdrawal")).movements.map((m) => m.id)).toEqual([
      withdrawal.id,
    ]);
    expect((await movementsJson("?provider=kamino")).movements.map((m) => m.id)).toEqual([
      deposit.movement.id,
    ]);
    expect(
      (await movementsJson(`?positionId=${deposit.position.id}`)).movements.map((m) => m.id)
    ).toEqual([deposit.movement.id]);
    // The B2B2X question: everything that came from this address.
    expect(
      (await movementsJson(`?sourceAddress=${PUBLIC_KEY_A}`)).movements.map((m) => m.id)
    ).toEqual([deposit.movement.id]);
    expect(
      (await movementsJson(`?destinationAddress=${PAYOUT}`)).movements.map((m) => m.id)
    ).toEqual([withdrawal.id]);
    expect((await movementsJson("?status=requested")).movements).toHaveLength(2);
    expect((await movementsJson("?status=finalized")).movements).toHaveLength(0);
  });

  it("pages by keyset without overlap or omission", async () => {
    const first = await seedVaultDeposit({ vault: "VaultFeedPage1111111111111111111111111111111" });
    const second = await seedVaultDeposit({
      vault: "VaultFeedPage2222222222222222222222222222222",
    });
    const third = await seedVaultDeposit({ vault: "VaultFeedPage3333333333333333333333333333333" });

    const page = await movementsJson("?limit=2");
    expect(page.movements.map((m) => m.id)).toEqual([third.movement.id, second.movement.id]);
    expect(page.hasMore).toBe(true);

    const next = await movementsJson(
      `?limit=2&before=${encodeURIComponent(page.nextCursor ?? "")}`
    );
    expect(next.movements.map((m) => m.id)).toEqual([first.movement.id]);
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor rather than ignoring it", async () => {
    expect((await listMovements("?before=not-a-cursor")).status).toBe(400);
  });

  describe("visibility is the union of what the per-family reads already grant", () => {
    it("hides another organization's movements", async () => {
      const mine = await seedVaultDeposit();
      const theirs = await seedForeignLedgerMovement({
        organizationId: ORG_OTHER,
        environment: "sandbox",
        vault: "VaultFeedForeignOrg1111111111111111111111111",
      });

      const body = await movementsJson();
      expect(body.movements.map((m) => m.id)).toEqual([mine.movement.id]);
      expect(body.movements.map((m) => m.id)).not.toContain(theirs);
    });

    it("hides another environment's movements", async () => {
      const sandbox = await seedVaultDeposit();
      // Same organization, same signing wallet: the environment is the only
      // difference, and the key is sandbox-scoped.
      const production = await seedForeignLedgerMovement({
        organizationId: ORG,
        environment: "production",
        vault: "VaultFeedProd11111111111111111111111111111111",
      });

      const body = await movementsJson();
      expect(body.movements.map((m) => m.id)).toEqual([sandbox.movement.id]);
      expect(body.movements.map((m) => m.id)).not.toContain(production);
    });

    it("hides a vault movement belonging to a sibling project", async () => {
      const mine = await seedVaultDeposit({ projectId: PROJECT_A, walletId: WALLET_A });
      const sibling = await seedVaultDeposit({
        projectId: PROJECT_B,
        walletId: WALLET_B,
        vault: "VaultFeedSibling1111111111111111111111111111",
      });

      // A vault movement is one project's transaction, so wallet scope alone does
      // not grant it — the exact project has to match.
      const body = await movementsJson();
      expect(body.movements.map((m) => m.id)).toContain(mine.movement.id);
      expect(body.movements.map((m) => m.id)).not.toContain(sibling.movement.id);
    });

    it("shows a custodial movement to any project in the environment", async () => {
      // Deliberately NOT project-scoped, matching /programs/:id/withdrawals: every
      // project in an environment reaches every program, so one program is one
      // history. Asserted so a future tightening is a decision, not an accident.
      const { withdrawal } = await seedProgramWithdrawal();
      await getDb(env)
        .prepare("UPDATE earn_movements SET project_id = ? WHERE id = ?")
        .bind(PROJECT_B, withdrawal.id)
        .run();

      expect((await movementsJson()).movements.map((m) => m.id)).toContain(withdrawal.id);
    });

    it("excludes vault movements when the key has no in-scope signing wallet, and still shows custodial ones", async () => {
      const { withdrawal } = await seedProgramWithdrawal();
      const deposit = await seedVaultDeposit({ walletId: WALLET_A });

      // A selected-scope key whose binding resolves to nothing has no readable
      // signing wallet, which is the degenerate end of the wallet-binding rule the
      // vault reads apply. It must not silently invert into "no filter": a vault
      // movement is one project's signed transaction and stays hidden, while
      // custodial movements remain visible because program wallets carry no such
      // binding. That asymmetry IS the visibility union.
      await bindKeyToWallets([]);

      const body = await movementsJson();
      expect(body.movements.map((m) => m.id)).toEqual([withdrawal.id]);
      expect(body.movements.map((m) => m.id)).not.toContain(deposit.movement.id);
    });
  });

  it("serves the feed with no provider credentials configured (ADR 0002 exit safety)", async () => {
    const deposit = await seedVaultDeposit();
    // The record of money that already moved must outlive the provider's
    // credentials, its entitlement, and its registry entry.
    env.GROUND_SANDBOX_API_KEY = undefined;

    const body = await movementsJson();
    expect(body.movements.map((m) => m.id)).toContain(deposit.movement.id);
  });
});
