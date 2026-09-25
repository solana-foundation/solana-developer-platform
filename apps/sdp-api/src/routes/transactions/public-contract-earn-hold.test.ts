import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * published-module allowlist (openapi/paths/transactions.ts), but the RUNTIME
 * keeps the full contract: it stays behind unified auth, and an authorized
 * `earn:read` key keeps reading Earn transactions through the shared list.
 * These tests pin both halves of that split — the published schema refuses
 * the held-back module while the runtime permission matrix still admits it —
 * so neither the document nor the runtime can silently regress into the
 * other's shape.
 */

const ALL_MODULES = ["payments", "earn", "dvp", "private_channels", "issuance", "rings"] as const;
const PUBLISHED_MODULES = ["payments", "dvp", "private_channels", "issuance", "rings"] as const;

describe("unified transactions publication hold (schemas)", () => {
  it("rejects the held-back module in the published query schema", () => {
    const published = unifiedTransactionsQuerySchemaForModules(PUBLISHED_MODULES);
    expect(published.safeParse({ module: "earn" }).success).toBe(false);
    // Published modules keep parsing, and the runtime schema still accepts
    // every module — the hold is a publication boundary, not a runtime one.
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
    // the unified list — the hold never narrows the runtime.
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
