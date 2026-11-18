import type { EarnDiscoveryResponse } from "@sdp/types/earn-core";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import type { UpsertEarnStrategyInput } from "@/db/repositories/earn.repository";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { app } from "@/index";
import { earnRoutes } from "@/routes/earn";
import {
  type EarnAuthzTenant,
  type EarnTestApiKey,
  seedEarnApiKey,
  seedEarnAuthzTenant,
} from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, readRateLimitCount } from "@/test/mocks/kv";

// These product-specific routes are absent, including their former 410 stubs.
const REMOVED_EARN_ROUTES = [
  "GET /provider-actions/:actionId",
  "POST /provider-actions/preparations",
  "POST /provider-actions/cancellations",
  "POST /provider-actions/external/preparation-transactions",
  "POST /provider-actions/external/cancellation-transactions",
  "POST /provider-actions/external/preparations",
  "POST /provider-actions/external/cancellations",
  "GET /strategies",
  "GET /strategies/:strategyId",
  "GET /external-wallet/positions/summary",
  "GET /external-wallet/positions",
  "GET /external-wallet/movements",
  "GET /external-wallet/movements/:movementId",
  "GET /external-wallet/earnings",
  "POST /vault-deposits",
  "POST /vault-deposit-previews",
  "GET /vault-deposits",
  "GET /vault-deposits/:movementId",
  "POST /vault-withdrawals",
  "POST /vault-withdrawal-previews",
  "POST /vault-withdrawal-options",
  "POST /vault-queued-withdrawal-previews",
  "GET /vault-withdrawals",
  "GET /vault-withdrawals/:movementId",
  "POST /vault-withdrawal-requests",
  "GET /vault-withdrawal-requests",
  "GET /vault-withdrawal-requests/:withdrawalRequestId",
  "POST /vault-withdrawal-requests/:withdrawalRequestId/cancel",
  "GET /vault-positions",
  "GET /vault-share-reconciliation",
  "POST /external-wallet/deposit-transactions",
  "POST /external-wallet/deposits",
  "POST /external-wallet/withdrawal-previews",
  "POST /external-wallet/withdrawal-transactions",
  "POST /external-wallet/withdrawal-options",
  "POST /external-wallet/queued-withdrawal-previews",
  "POST /external-wallet/withdrawal-request-transactions",
  "POST /external-wallet/withdrawal-request-cancel-transactions",
  "POST /external-wallet/withdrawals",
  "POST /external-wallet/withdrawal-requests",
  "POST /external-wallet/withdrawal-request-cancellations",
  "GET /external-wallet/withdrawal-requests",
  "GET /external-wallet/withdrawal-requests/:withdrawalRequestId",
  "GET /movements",
  "GET /programs",
  "POST /programs",
  "GET /programs/:programId",
  "PUT /programs/:programId",
  "GET /programs/:programId/deposits",
  "POST /programs/:programId/withdrawal-preview",
  "POST /programs/:programId/withdrawals",
  "GET /programs/:programId/withdrawals",
  "GET /programs/:programId/withdrawals/:withdrawalRef",
] as const;

let tenant: EarnAuthzTenant;
let key: EarnTestApiKey;

beforeEach(async () => {
  await seedTestDatabase(env);
  await clearKVStores(env);
  tenant = await seedEarnAuthzTenant(env, "earn_core_surface", { environment: "sandbox" });
  key = await seedEarnApiKey(env, tenant, {
    id: "earn_core_surface",
    grants: ["earn.read", "earn.execute", "earn.manage"],
    environment: "sandbox",
  });
});

async function strategy(overrides: Partial<UpsertEarnStrategyInput> = {}) {
  const row = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "kamino",
    providerReference: crypto.randomUUID(),
    name: "Indexed USDC strategy",
    sourceKind: "defi",
    underlyingSource: null,
    depositMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    shareMint: "So11111111111111111111111111111111111111112",
    apyType: "variable",
    currentApy: "0.06",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    riskMetadata: {},
    status: "active",
    hostCluster: "devnet",
    environment: "sandbox",
    ...overrides,
  });
  if (!row) throw new Error("Missing strategy fixture");
  return row;
}

function get(path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers: { Authorization: `Bearer ${key.raw}`, ...headers } }, env);
}

describe("Earn core HTTP surface", () => {
  it("does not mount any removed product route or retirement stub", async () => {
    const mounted = new Set(earnRoutes.routes.map(({ method, path }) => `${method} ${path}`));
    for (const route of REMOVED_EARN_ROUTES) {
      expect(mounted.has(route), route).toBe(false);
      const [method, pattern] = route.split(" ");
      if (!method || !pattern) throw new Error("Invalid removed route fixture");
      const response = await app.request(
        `/v1/earn${pattern.replace(/:[A-Za-z]+/g, "removed-resource")}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${key.raw}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          ...(method === "GET" ? {} : { body: "{}" }),
        },
        env
      );
      expect(response.status, route).toBe(404);
    }
  });

  it("keeps earlier removed detail, quote and configuration paths absent", async () => {
    for (const path of [
      "/positions/position-id",
      "/movements/movement-id",
      "/quote",
      "/nav",
      "/program",
      "/button-configurations",
    ])
      expect((await get(`/v1/earn${path}`)).status, path).toBe(404);
  });

  it("keeps discovery privately cacheable and applies keyed middleware once", async () => {
    const response = await get("/v1/earn/discovery", { Origin: "http://localhost:3000" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(await readRateLimitCount(env, key.id)).toBe(1);
  });

  it("scopes discovery to the API key environment, including ID filters", async () => {
    const sandbox = await strategy();
    const production = await strategy({ environment: "production", hostCluster: "mainnet-beta" });
    const response = await get("/v1/earn/discovery");
    const body: { data: EarnDiscoveryResponse } = await response.json();
    expect(body.data.strategies.map(({ id }) => id)).toEqual([sandbox.id]);
    expect(await (await get(`/v1/earn/discovery?id=${production.id}`)).json()).toMatchObject({
      data: { strategies: [], total: 0 },
    });
  });

  it("scopes dashboard discovery to the selected project environment", async () => {
    const sandbox = await strategy();
    const production = await strategy({ environment: "production", hostCluster: "mainnet-beta" });
    const response = await app.request(
      "/v1/earn/discovery",
      {
        headers: {
          Authorization: `Bearer ${tenant.token}`,
          "x-project-id": "prj_earn_core_surface_production",
        },
      },
      env
    );
    expect(response.status).toBe(200);
    const body: { data: EarnDiscoveryResponse } = await response.json();
    expect(body.data.strategies.map(({ id }) => id)).toEqual([production.id]);
    expect(JSON.stringify(body)).not.toContain(sandbox.id);
  });
});
