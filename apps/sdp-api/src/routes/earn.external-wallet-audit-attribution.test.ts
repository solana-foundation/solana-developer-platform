/**
 * Regression for SOLA9-646 (APE-825): the external-wallet withdrawal repair
 * must not seal the RETRY request's correlation in `audit_logs.request_id`.
 *
 * `earn_movements.request_id` stores the business idempotency key, and the
 * original HTTP request's `X-Request-ID` is not recoverable from durable
 * state once its post-effect audit append has failed. The backfilled row
 * therefore records an unattributable request correlation (NULL) and keeps
 * the retry's correlation as repair metadata, instead of attributing the
 * money effect to a request that caused nothing.
 *
 * The route, request-ID middleware, real PostgreSQL audit ledger, hash
 * trigger, and replay repair code are exercised; the withdrawal service is
 * mocked (no Solana or provider contact).
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { AUDIT_LEDGER_CHECKPOINT_KEY, AuditService } from "@/services/audit.service";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const submitExternalWalletWithdrawal = vi.hoisted(() => vi.fn());

vi.mock("@/services/earn/vault-external-wallet.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-external-wallet.service")>()),
  submitExternalWalletWithdrawal,
}));

const ORG = { id: "org_audit_attr", name: "Audit Attribution Org", slug: "audit-attr" };
const PROJECT = { id: "prj_audit_attr", slug: "audit-attr-project" };
const PRODUCTION_PROJECT_ID = "prj_audit_attr_prod";
const API_KEY = { id: "key_audit_attr", raw: "sk_test_audit_attr", prefix: "sk_test_aud" };
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const MOVEMENT_ID = "earn_movement_audit_attr";
const IDEMPOTENCY_KEY = "business-withdrawal-key";
const EFFECT_REQUEST_ID = "req_effect_causing_submit";
const REPAIR_REQUEST_ID = "req_retry_repair";

const CACHED_API_KEY: CachedApiKey = {
  id: API_KEY.id,
  organizationId: ORG.id,
  projectId: PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

function movement(replayed: boolean) {
  return {
    id: MOVEMENT_ID,
    position_id: "earn_position_audit_attr",
    provider: "kamino",
    vault_address: VAULT,
    direction: "withdrawal",
    status: "submitted",
    signature: "sig_audit_attr",
    owner_address: OWNER,
    amount_requested: "10",
    denomination: "So11111111111111111111111111111111111111112",
    failure_reason: null,
    created_at: new Date().toISOString(),
    confirmed_at: null,
    settled_at: null,
    created_by: null,
    initiated_by_key_id: API_KEY.id,
    replayed,
  };
}

async function seedAuth() {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, 'audit-attr', 'enterprise', 'active', '{}')"
      )
      .bind(ORG.id, ORG.name),
    getDb(env).prepare(
      "INSERT INTO users (id, email, email_verified, status) VALUES ('usr_audit_attr', 'audit-attr@example.com', 1, 'active')"
    ),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: ORG.id,
    createdBy: "usr_audit_attr",
    members: [],
    ids: { sandbox: PROJECT.id, production: PRODUCTION_PROJECT_ID },
  });
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, 'usr_audit_attr', 'Audit Attribution Key', ?, ?, 'api_admin', '["*"]', 'active')`
    )
    .bind(API_KEY.id, ORG.id, PROJECT.id, API_KEY.prefix, keyHash)
    .run();
}

function post(requestId: string) {
  return app.request(
    "/v1/earn/external-wallet/withdrawals",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": IDEMPOTENCY_KEY,
        "X-Request-ID": requestId,
      },
      body: JSON.stringify({
        transactionId: "earn_external_wallet_tx_audit_attr",
        signedTransaction: "AQ==",
      }),
    },
    env
  );
}

async function withdrawAuditRow() {
  return getDb(env)
    .prepare(
      `SELECT request_id, metadata, entry_hash
         FROM audit_logs
        WHERE action = 'withdraw' AND resource_type = 'earn_movement' AND resource_id = ?`
    )
    .bind(MOVEMENT_ID)
    .first<{ request_id: string | null; metadata: string; entry_hash: string }>();
}

describe("external-wallet withdrawal audit request attribution", () => {
  let originalMarketsEnabled: string | undefined;
  let originalEarnEnabled: string | undefined;

  beforeEach(async () => {
    originalMarketsEnabled = env.MARKETS_ENABLED;
    originalEarnEnabled = env.EARN_ENABLED;
    env.EARN_ENABLED = "true";
    env.MARKETS_ENABLED = "true";
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedAuth();
    submitExternalWalletWithdrawal.mockReset();
    submitExternalWalletWithdrawal
      .mockResolvedValueOnce({
        position: { id: "earn_position_audit_attr", token_mint: "USDC" },
        movement: movement(false),
        replayed: false,
      })
      .mockResolvedValueOnce({
        position: { id: "earn_position_audit_attr", token_mint: "USDC" },
        movement: movement(true),
        replayed: true,
      });
  });

  afterEach(() => {
    env.MARKETS_ENABLED = originalMarketsEnabled;
    env.EARN_ENABLED = originalEarnEnabled;
    vi.restoreAllMocks();
  });

  it("does not seal the retry request ID when backfilling a replayed withdrawal", async () => {
    // Sabotage the external checkpoint so the FIRST request's post-effect
    // audit append fails after the money effect: the ledger is left silent
    // about a movement that exists, the exact crash window the repair exists
    // for.
    const checkpoint = createKVStoreSet(env).cache;
    await checkpoint.put(AUDIT_LEDGER_CHECKPOINT_KEY, '{"sequence":1,"headHash":"bad"}');

    const first = await post(EFFECT_REQUEST_ID);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Request-ID")).toBe(EFFECT_REQUEST_ID);
    expect(
      (
        await getDb(env)
          .prepare("SELECT count(*)::int AS count FROM audit_logs WHERE resource_id = ?")
          .bind(MOVEMENT_ID)
          .first<{ count: number }>()
      )?.count
    ).toBe(0);
    await checkpoint.delete(AUDIT_LEDGER_CHECKPOINT_KEY);

    const retry = await post(REPAIR_REQUEST_ID);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("X-Request-ID")).toBe(REPAIR_REQUEST_ID);
    await expect(retry.json()).resolves.toMatchObject({
      data: { withdrawal: { movementId: MOVEMENT_ID, replayed: true } },
    });

    const row = await withdrawAuditRow();
    // The repair must not attribute the effect to the retry request: the
    // immutable correlation column records "unattributable" because the
    // effect-causing request's ID was never durable.
    expect(row?.request_id).toBeNull();
    expect(row?.request_id).not.toBe(REPAIR_REQUEST_ID);
    expect(row?.request_id).not.toBe(EFFECT_REQUEST_ID);
    // The business idempotency key stays in metadata, the repair is visible,
    // and the retry's own correlation is repair metadata only.
    expect(row?.metadata).toContain('"requestId":"business-withdrawal-key"');
    expect(row?.metadata).toContain('"backfilledOnReplay":true');
    expect(row?.metadata).toContain(`"repairRequestId":"${REPAIR_REQUEST_ID}"`);
    expect(row?.entry_hash).toBeTruthy();
    await expect(
      new AuditService(getDb(env), createKVStoreSet(env).cache).verifyIntegrity()
    ).resolves.toMatchObject({ valid: true, checkedEntries: 1 });
    expect(submitExternalWalletWithdrawal).toHaveBeenCalledTimes(2);
  });

  it("seals the submit's own request ID on the initial (non-replay) append", async () => {
    const first = await post(EFFECT_REQUEST_ID);
    expect(first.status).toBe(200);

    const row = await withdrawAuditRow();
    expect(row?.request_id).toBe(EFFECT_REQUEST_ID);
    expect(row?.metadata).not.toContain("backfilledOnReplay");
  });
});
