import { UNIFIED_TRANSACTION_MODULE_CONTRACTS, UNIFIED_TRANSACTION_STATUSES } from "@sdp/types";
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
 * published-module allowlist (openapi/paths/transactions.ts, via
 * publication.ts): the held-back module is omitted from the module selector
 * and its branch and status vocabulary from the response union, so the
 * published contract cannot name it. The hold is a DOCUMENT boundary only —
 * the runtime is unchanged — so the published response union carries the
 * module-agnostic variant (`unpublishedModuleTransactionSchema`): an
 * unfiltered read still returns held-back rows to an authorized caller, and
 * a client generated from the public document must parse them even though
 * the document never names their module. The hold also never narrows an
 * explicitly requested module — the runtime permission matrix admits
 * `module=earn` for an authorized `earn:read` key exactly as before — and
 * dashboard callers (Clerk/session) keep the full internal contract. These
 * tests pin both halves: the published schema refuses the held-back module
 * in the selector while still parsing its rows through the open variant, and
 * every caller keeps the exact rows it was entitled to before the hold.
 */

const ALL_MODULES = ["payments", "earn", "dvp", "private_channels", "issuance", "rings"] as const;
const PUBLISHED_MODULES = ["payments", "dvp", "private_channels", "issuance", "rings"] as const;

/**
 * A minimal transaction of the held-back module, in the exact shape the
 * unified view serves: the shared envelope plus the held-back module's
 * module/kind/moduleStatus vocabulary.
 */
function earnTransactionFixture() {
  return {
    id: "txn_earn_hold_fixture",
    moduleId: "module_earn_hold_fixture",
    module: "earn",
    kind: UNIFIED_TRANSACTION_MODULE_CONTRACTS.earn.kinds[0],
    status: UNIFIED_TRANSACTION_STATUSES[0],
    moduleStatus: UNIFIED_TRANSACTION_MODULE_CONTRACTS.earn.moduleStatuses[0],
    organizationId: "org_earn_hold_fixture",
    projectId: null,
    custodyWalletId: null,
    custodyWalletLabel: null,
    token: null,
    amount: "1",
    counterpartyId: null,
    signature: null,
    createdAt: "2026-09-20T10:00:00.000Z",
  };
}

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

  it("parses a held-back row through the published union's module-agnostic variant without naming it", () => {
    // The closed published union omits the held-back module's branch (the
    // internal document's union keeps it), and an empty page parses either
    // way.
    const closed = unifiedTransactionsListResponseSchemaForModules(PUBLISHED_MODULES);
    expect(JSON.stringify(closed)).not.toContain('"earn"');
    expect(closed.parse({ transactions: [], nextCursor: null }).transactions).toEqual([]);
    const runtime = unifiedTransactionsListResponseSchemaForModules(ALL_MODULES);
    expect(JSON.stringify(runtime)).toContain('"earn"');

    // A held-back row cannot parse against the closed union, but the
    // published document ships with the module-agnostic variant appended —
    // the response the unfiltered default can carry must parse against the
    // contract a client is generated from.
    expect(
      closed.safeParse({ transactions: [earnTransactionFixture()], nextCursor: null }).success
    ).toBe(false);
    const published = unifiedTransactionsListResponseSchemaForModules(PUBLISHED_MODULES, {
      openUnpublished: true,
    });
    expect(JSON.stringify(published)).not.toContain('"earn"');
    expect(
      published.parse({ transactions: [earnTransactionFixture()], nextCursor: null }).transactions
    ).toHaveLength(1);
    expect(
      runtime.parse({ transactions: [earnTransactionFixture()], nextCursor: null }).transactions
    ).toHaveLength(1);
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

  const publishedResponseSchema = () =>
    unifiedTransactionsListResponseSchemaForModules(PUBLISHED_MODULES, { openUnpublished: true });

  it("keeps the unfiltered default serving every module the caller can read, and parseable under the published contract", async () => {
    // The hold is a document boundary, so the runtime is unchanged: the
    // unfiltered default still returns the held-back row the caller is
    // entitled to — it is not narrowed behind the caller's back.
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
    ).toContain("earn");

    // And the body still parses against the PUBLISHED response schema — the
    // contract a client generated from the public document is built from —
    // through the module-agnostic variant that names no held-back family.
    expect(publishedResponseSchema().safeParse(unfilteredBody.data).success).toBe(true);
    expect(
      unifiedTransactionsListResponseSchemaForModules(ALL_MODULES).safeParse(unfilteredBody.data)
        .success
    ).toBe(true);

    // An explicit read keeps working for the same key.
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
  });

  it("keeps an earn-only key's unfiltered read returning its authorized held-back rows", async () => {
    // An earn:read-only key is entitled to exactly one module, and the
    // unfiltered default still serves it: an authorized read never comes
    // back silently emptied by a publication boundary.
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
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { transactions?: Array<{ module?: string }> };
    };
    expect((body.data?.transactions ?? []).map((transaction) => transaction.module)).toEqual([
      "earn",
    ]);
    expect(publishedResponseSchema().safeParse(body.data).success).toBe(true);

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

  it("keeps the dashboard's unfiltered view on the full internal contract", async () => {
    // The dashboard authenticates with a session, not an API key, and runs
    // under the internal contract: its unfiltered "All" view keeps returning
    // the held-back module's rows.
    const dashboardResponse = await app.request(
      "/v1/transactions",
      {
        headers: {
          Cookie: `sdp_session=${tenant.sessionId}`,
          "x-project-id": tenant.project.id,
          "x-forwarded-for": "10.0.0.105",
        },
      },
      env
    );
    expect(dashboardResponse.status).toBe(200);
    const dashboardBody = (await dashboardResponse.json()) as {
      data?: { transactions?: Array<{ module?: string }> };
    };
    expect(
      (dashboardBody.data?.transactions ?? []).map((transaction) => transaction.module)
    ).toContain("earn");
    expect(
      unifiedTransactionsListResponseSchemaForModules(ALL_MODULES).safeParse(dashboardBody.data)
        .success
    ).toBe(true);
  });
});
