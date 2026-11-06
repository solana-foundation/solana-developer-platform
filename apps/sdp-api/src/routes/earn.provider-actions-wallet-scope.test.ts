import assert from "node:assert/strict";
import { hashString } from "@sdp/payments/hash";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import { app } from "@/index";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const surfacingEnabled = vi.hoisted(() => ({ value: true }));

vi.mock("@sdp/types/provider-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/provider-access")>()),
  isEarnProviderSurfaced: () => surfacingEnabled.value,
}));

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

vi.mock("@/services/earn/vault-movement-reconciliation.service", () => ({
  reconcileEarnVaultMovementReadThrough: async () => {},
}));

/**
 * Custody-signed provider actions must refuse a custody wallet outside the
 * calling key's scope in `authorize` — before the idempotency claim, the
 * audit intent, or any `earn_provider_actions` row (same contract as the
 * vault deposit route). Referenced by
 * `src/routes/wallet-scope-route-inventory.test.ts` as refusal evidence.
 */

const TEST_ORG = {
  id: "org_earn_pa_scope",
  name: "Earn Provider Scope Org",
  slug: "earn-pa-scope",
};
const TEST_PROJECT = { id: "prj_test_earn_pa_scope", slug: "test-earn-pa-scope-project" };
const TEST_PRODUCTION_PROJECT = {
  id: "prj_test_earn_pa_scope_prod",
  slug: "test-earn-pa-scope-project-prod",
};
const TEST_USER = { id: "usr_earn_pa_scope", email: "earn-pa-scope@example.com" };
const TEST_API_KEY = {
  id: "key_earn_pa_scope",
  raw: "sk_test_earn_pa_scope",
  prefix: "sk_test_eas",
};
const WALLET_SCOPED_KEY = {
  id: "key_earn_pa_scope_wallet",
  raw: "sk_test_earn_pa_scope_wallet",
  prefix: "sk_test_easw",
};
const TEST_SEEDED_API_KEY: SeededApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  status: "active",
  expiresAt: null,
};

const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const SHARE_MINT = SOL_MINT;
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CUSTODY_WALLET_ID = "cwlt_earn_pa_scope";
const CONNECTION_ID = "cconn_earn_pa_scope";

let originalEncryptionKey: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active", "{}"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
  });

  // The key under test: wallet scope "selected" with no wallets granted, so
  // every custody-signed route must refuse it before writing anything.
  const walletScopedHash = await hashString(WALLET_SCOPED_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, walletScopedHash, {
    ...TEST_SEEDED_API_KEY,
    id: WALLET_SCOPED_KEY.id,
    walletScope: "selected",
    walletIds: [],
  });
}

async function seedConnectionWallet(): Promise<void> {
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("base64");
  await seedTestPrivyConnection(getDb(env), {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    connectionId: CONNECTION_ID,
    credentialId: "pcred_earn_pa_scope",
    createdBy: TEST_USER.id,
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: TEST_ORG.id,
      credentialId: "pcred_earn_pa_scope",
      appId: "earn-pa-scope-app",
      appSecret: "earn-pa-scope-secret",
    }),
    providerAccountFingerprint: "sha256:earn-pa-scope",
    lastCheckStatus: "success",
    wallets: [
      {
        id: CUSTODY_WALLET_ID,
        walletId: "privy_earn_pa_scope",
        publicKey: WALLET_ADDRESS,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
    defaultCustodyWalletId: CUSTODY_WALLET_ID,
  });
}

async function seedStrategy(): Promise<string> {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "kamino",
    providerReference: VAULT,
    name: "Provider Action Scope Vault",
    sourceKind: "defi",
    underlyingSource: "kamino",
    depositMints: [USDC_MINT],
    shareMint: SHARE_MINT,
    apyType: "variable",
    currentApy: "0.062",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    riskMetadata: {},
    status: "active",
    hostCluster: "devnet",
    environment: "sandbox",
  });
  assert(strategy);
  return strategy.id;
}

async function seedWithdrawalMovement(): Promise<string> {
  const positionId = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint,
         provider_wallet_id, label, activated_at
       ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, NULL, 'Exit Vault', sdp_iso_now())`
    )
    .bind(positionId, TEST_ORG.id, TEST_PROJECT.id, CUSTODY_WALLET_ID, VAULT, SHARE_MINT, USDC_MINT)
    .run();
  const movementId = `earn_movement_${crypto.randomUUID()}`;
  await getDb(env)
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         denomination, amount_requested, custody_wallet_id, vault_address,
         signature, signed_transaction, last_valid_block_height,
         request_id, idempotency_fingerprint
       ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', 'withdrawal', ?, 'submitted',
                 ?, '10', ?, ?, 'sig_pa_scope_parent', 'AQ==', '100', ?, 'fp_pa_scope')`
    )
    .bind(
      movementId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      positionId,
      SHARE_MINT,
      CUSTODY_WALLET_ID,
      VAULT,
      crypto.randomUUID()
    )
    .run();
  return movementId;
}

function postAsWalletScopedKey(path: string, body: Record<string, unknown>) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WALLET_SCOPED_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `idem_${crypto.randomUUID()}`,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

async function countProviderActions(): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::int AS total FROM earn_provider_actions")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

beforeEach(async () => {
  originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
  surfacingEnabled.value = true;
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
});

afterEach(() => {
  env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("custody provider actions refuse out-of-scope wallets early", () => {
  it("refuses a preparation for a custody wallet outside the key's scope before creating the action", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategyId = await seedStrategy();

    const res = await postAsWalletScopedKey("/v1/earn/provider-actions/preparations", {
      strategyId,
      custodyWalletId: CUSTODY_WALLET_ID,
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN", details: { reason: "wallet_out_of_scope" } },
    });
    await expect(countProviderActions()).resolves.toBe(0);
  });

  it("refuses a cancellation whose custody wallet is outside the key's scope before creating the action", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const movementId = await seedWithdrawalMovement();

    const res = await postAsWalletScopedKey("/v1/earn/provider-actions/cancellations", {
      movementId,
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN", details: { reason: "wallet_out_of_scope" } },
    });
    await expect(countProviderActions()).resolves.toBe(0);
  });
});
