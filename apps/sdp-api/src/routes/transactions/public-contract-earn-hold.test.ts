import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import app from "@/index";
import { type EarnAuthzTenant, seedEarnApiKey, seedEarnAuthzTenant } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import {
  unifiedTransactionsListResponseSchemaForModules,
  unifiedTransactionsQuerySchemaForModules,
} from "./schemas";

/**
 * Publication hold for the unified transaction contract (SOLA9-85).
 *
 * The public OpenAPI document narrows `/v1/transactions` to the
 * published-module allowlist (openapi/paths/transactions.ts), and the
 * runtime's UNFILTERED default narrows with it (handlers.ts, via
 * publication.ts): a response built without an explicit module filter never
 * carries a row the published response schema does not describe, so a client
 * generated from the public document only ever parses what it was built for.
 * The hold still never narrows an explicitly requested module — the runtime
 * permission matrix admits `module=earn` for an authorized `earn:read` key
 * exactly as before. These tests pin both halves of that split — the
 * published schema refuses the held-back module while explicit authorized
 * reads still reach it, and the unfiltered default stays inside the published
 * contract — so neither the document nor the runtime can silently regress
 * into the other's shape.
 */

const ALL_MODULES = ["payments", "earn", "dvp", "private_channels", "issuance", "rings"] as const;
const PUBLISHED_MODULES = ["payments", "dvp", "private_channels", "issuance", "rings"] as const;

describe("unified transactions publication hold (schemas)", () => {
  it("rejects the held-back module in the published query schema", () => {
    const published = unifiedTransactionsQuerySchemaForModules(PUBLISHED_MODULES);
    expect(published.safeParse({ module: "earn" }).success).toBe(false);
    // Published modules keep parsing, and the runtime schema still accepts
    // every module — the hold never narrows an explicitly requested module.
    expect(published.safeParse({ module: "payments" }).success).toBe(true);
    const runtime = unifiedTransactionsQuerySchemaForModules(ALL_MODULES);
    expect(runtime.safeParse({ module: "earn" }).success).toBe(true);
  });

  it("omits the held-back module's branch from the published response union", () => {
    const published = unifiedTransactionsListResponseSchemaForModules(PUBLISHED_MODULES);
    const parsed = published.parse({ transactions: [], nextCursor: null });
    expect(parsed.transactions).toEqual([]);
    expect(JSON.stringify(published)).not.toContain('"earn"');

    const runtime = unifiedTransactionsListResponseSchemaForModules(ALL_MODULES);
    expect(JSON.stringify(runtime)).toContain('"earn"');
  });
});

describe("unified transactions publication hold (runtime)", () => {
  let tenant: EarnAuthzTenant;
  let rawEarnReadKey: string;
  let originalEarnEnabled: string | undefined;

  beforeEach(async () => {
    originalEarnEnabled = env.EARN_ENABLED;
    env.EARN_ENABLED = "true";
    await seedTestDatabase(env);
    await clearKVStores(env);
    tenant = await seedEarnAuthzTenant(env, "public_transactions_earn_hold");
    const key = await seedEarnApiKey(env, tenant, {
      id: "key_public_transactions_earn_hold",
      permissions: ["earn:read"],
    });
    rawEarnReadKey = key.raw;
  });

  afterEach(() => {
    env.EARN_ENABLED = originalEarnEnabled;
  });

  it("keeps the route authenticated and the earn:read flow reachable", async () => {
    // Anonymous callers still hold no tenant context.
    const anonymousResponse = await app.request("/v1/transactions?module=earn", {}, env);
    expect(anonymousResponse.status).toBe(401);

    // An authorized earn:read key keeps reading the held-back module through
    // the unified list — the hold never narrows an explicitly requested
    // module.
    const authorizedResponse = await app.request(
      "/v1/transactions?module=earn",
      {
        headers: {
          Authorization: `Bearer ${rawEarnReadKey}`,
          "x-forwarded-for": "10.0.0.99",
        },
      },
      env
    );
    expect(authorizedResponse.status).toBe(200);
    const authorizedBody = (await authorizedResponse.json()) as {
      data?: { transactions?: unknown[]; nextCursor?: string | null };
    };
    expect(authorizedBody.data?.transactions).toEqual([]);
    expect(authorizedBody.data?.nextCursor).toBeNull();

    // The module permission matrix is unchanged: earn:read cannot read
    // payments.
    const unauthorizedModuleResponse = await app.request(
      "/v1/transactions?module=payments",
      {
        headers: {
          Authorization: `Bearer ${rawEarnReadKey}`,
          "x-forwarded-for": "10.0.0.100",
        },
      },
      env
    );
    expect(unauthorizedModuleResponse.status).toBe(403);
  });
});

/**
 * Seeds one custodial Earn movement (a completed withdrawal) for `tenant`'s
 * org and pinned project — the minimal shape the unified view turns into a
 * `module: "earn"` row (same custodial fixture as the unified-view tests).
 */
async function seedEarnMovement(tenant: EarnAuthzTenant, id: string): Promise<void> {
  const db = getDb(env);
  const now = "2026-09-20T10:00:00.000Z";
  await db.execute(
    `INSERT INTO earn_provider_wallets
         (id, organization_id, project_id, environment, provider, provider_wallet_ref, label, created_by)
       VALUES ('earn_provider_wallet_earn_hold', ?, ?, 'sandbox', 'ground', 'provider-ref', 'Program', ?)
       ON CONFLICT (id) DO NOTHING`,
    [tenant.org.id, tenant.project.id, tenant.user.id]
  );
  await db.execute(
    `INSERT INTO earn_positions
         (id, organization_id, project_id, environment, provider, kind, provider_wallet_id,
          label, created_by, activated_at)
       VALUES ('earn_position_earn_hold', ?, ?, 'sandbox', 'ground', 'custodial',
               'earn_provider_wallet_earn_hold', 'Program', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    [tenant.org.id, tenant.project.id, tenant.user.id, now]
  );
  await db.execute(
    `INSERT INTO earn_movements
       (id, organization_id, project_id, environment, provider, execution_model, direction,
        position_id, status, failure_reason, confirmed_at, settled_at, denomination,
        amount_requested, amount_settled, min_shares_out, shares_out, payout_token,
        custody_wallet_id, vault_address, signature, signed_transaction,
        last_valid_block_height, request_id, idempotency_fingerprint, created_by,
        created_at, updated_at)
     VALUES (?, ?, ?, 'sandbox', 'ground', 'custodial', 'withdrawal', 'earn_position_earn_hold',
             'completed', NULL, ?, NULL, 'usd', '1', '1', NULL, NULL, 'usdc',
             NULL, NULL, NULL, NULL, NULL, ?, 'fingerprint_earn_hold', ?, ?, ?)`,
    [id, tenant.org.id, tenant.project.id, now, `request-${id}`, tenant.user.id, now, now]
  );
}

describe("unified transactions publication hold (unfiltered default)", () => {
  let tenant: EarnAuthzTenant;
  let rawEarnReadKey: string;
  let rawFullKey: string;
  let originalEarnEnabled: string | undefined;

  beforeEach(async () => {
    originalEarnEnabled = env.EARN_ENABLED;
    env.EARN_ENABLED = "true";
    await seedTestDatabase(env);
    await clearKVStores(env);
    tenant = await seedEarnAuthzTenant(env, "public_transactions_earn_hold_unfiltered");
    const earnReadKey = await seedEarnApiKey(env, tenant, {
      id: "key_earn_hold_unfiltered_earn_read",
      permissions: ["earn:read"],
    });
    rawEarnReadKey = earnReadKey.raw;
    // The default key posture: full permissions, like every pre-provisioned
    // key. Its unfiltered read is the one a public-contract client performs.
    const fullKey = await seedEarnApiKey(env, tenant, {
      id: "key_earn_hold_unfiltered_full",
      permissions: ["*"],
    });
    rawFullKey = fullKey.raw;
    await seedEarnMovement(tenant, "earn_movement_earn_hold_unfiltered");
  });

  afterEach(() => {
    env.EARN_ENABLED = originalEarnEnabled;
  });

  it("keeps a held-back row out of an unfiltered response a public client must parse", async () => {
    // The seed produced a real Earn row, and an explicit read still reaches
    // it — the assertion below is not passing because the fixture is empty.
    const explicitResponse = await app.request(
      "/v1/transactions?module=earn",
      {
        headers: {
          Authorization: `Bearer ${rawFullKey}`,
          "x-forwarded-for": "10.0.0.101",
        },
      },
      env
    );
    expect(explicitResponse.status).toBe(200);
    const explicitBody = (await explicitResponse.json()) as {
      data?: { transactions?: Array<{ module?: string }> };
    };
    expect(
      (explicitBody.data?.transactions ?? []).map((transaction) => transaction.module)
    ).toEqual(["earn"]);

    // The unfiltered default never returns the held-back row, and the body
    // parses against the PUBLISHED response schema — the contract a client
    // generated from the public document is built from.
    const unfilteredResponse = await app.request(
      "/v1/transactions",
      {
        headers: {
          Authorization: `Bearer ${rawFullKey}`,
          "x-forwarded-for": "10.0.0.102",
        },
      },
      env
    );
    expect(unfilteredResponse.status).toBe(200);
    const unfilteredBody = (await unfilteredResponse.json()) as {
      data?: { transactions?: Array<{ module?: string }> };
    };
    expect(
      (unfilteredBody.data?.transactions ?? []).map((transaction) => transaction.module)
    ).not.toContain("earn");
    expect(
      unifiedTransactionsListResponseSchemaForModules(PUBLISHED_MODULES).safeParse(
        unfilteredBody.data
      ).success
    ).toBe(true);
  });

  it("answers an unfiltered read that can only ever see held-back modules with INSUFFICIENT_PERMISSIONS", async () => {
    // An earn:read-only key has no published module to fall back to, so its
    // unfiltered read is refused like any other zero-module caller instead of
    // answering with a body the published contract cannot describe.
    const response = await app.request(
      "/v1/transactions",
      {
        headers: {
          Authorization: `Bearer ${rawEarnReadKey}`,
          "x-forwarded-for": "10.0.0.103",
        },
      },
      env
    );
    expect(response.status).toBe(403);

    // The explicit read keeps working for the same key.
    const explicitResponse = await app.request(
      "/v1/transactions?module=earn",
      {
        headers: {
          Authorization: `Bearer ${rawEarnReadKey}`,
          "x-forwarded-for": "10.0.0.104",
        },
      },
      env
    );
    expect(explicitResponse.status).toBe(200);
  });
});
