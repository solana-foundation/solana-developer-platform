import { beforeEach, describe, expect, it } from "vitest";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const OWNER = "7YfVedaQueueOwner111111111111111111111111111";

beforeEach(async () => {
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
  await clearKVStores(env);
});

describe("queued withdrawal route auth tiers", () => {
  it("never downgrades a presented invalid credential on an optional-auth build route", async () => {
    const response = await app.request(
      "/v1/earn/external-wallet/withdrawal-options",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sk_test_invalid_queued_withdrawal",
          "content-type": "application/json",
        },
        body: JSON.stringify({ strategyId: "earn_strategy_missing", ownerAddress: OWNER }),
      },
      env
    );
    expect(response.status).toBe(401);
  });

  it("keeps discovery anonymous while request builds and tenant reads stay keyed", async () => {
    const optional = await app.request(
      "/v1/earn/external-wallet/withdrawal-options",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategyId: "earn_strategy_missing", ownerAddress: OWNER }),
      },
      env
    );
    expect(optional.status).not.toBe(401);

    const requestBuild = await app.request(
      "/v1/earn/external-wallet/withdrawal-request-transactions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positionId: "earn_position_missing",
          shares: "1",
          discountBps: 0,
          deadlineSeconds: 300,
        }),
      },
      env
    );
    expect(requestBuild.status).toBe(401);

    const cancelBuild = await app.request(
      "/v1/earn/external-wallet/withdrawal-request-cancel-transactions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withdrawalRequestId: "earn_withdrawal_request_missing" }),
      },
      env
    );
    expect(cancelBuild.status).toBe(401);

    const externalHistory = await app.request(
      `/v1/earn/external-wallet/withdrawal-requests?ownerAddress=${OWNER}`,
      {},
      env
    );
    expect(externalHistory.status).toBe(401);

    const custodyOptions = await app.request(
      "/v1/earn/vault-withdrawal-options",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ positionId: "earn_position_missing" }),
      },
      env
    );
    expect(custodyOptions.status).toBe(401);
  });
});
