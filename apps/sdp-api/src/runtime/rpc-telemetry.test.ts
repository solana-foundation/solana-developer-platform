import { SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "@/index";
import { installClusterRpcResponder, tokenAccountsByOwnerResult } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { installLogLineCapture } from "@/test/helpers/log-lines";
import {
  getAccountInfoMock,
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

const BALANCES_ROUTE = "GET /v1/payments/wallets/:walletId/balances";
const WALLET_ROUTE = "GET /v1/wallets/:walletId";

describe("managed pool RPC log lines through the app", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();
  const lines = installLogLineCapture();

  beforeEach(() => {
    getAccountInfoMock.mockReset();
    rpc.answer("getAccountInfo", { context: { slot: 1 }, value: null });
    rpc.answer("getTokenAccountsByOwner", tokenAccountsByOwnerResult(1, []));
  });

  function getAsKey(path: string) {
    return app.request(path, { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } }, env);
  }

  function accountReads() {
    return lines.filter((line) => line.method === "getAccountInfo");
  }

  it("samples each route's successful attempts on its own: ten at weight 1, then every tenth at weight 10", async () => {
    const statuses: number[] = [];
    const balancesRequestIds: (string | null)[] = [];
    for (let index = 0; index < 30; index += 1) {
      const balances = await getAsKey(`/v1/payments/wallets/${TEST_WALLET_ID}/balances`);
      balancesRequestIds.push(balances.headers.get("X-Request-ID"));
      statuses.push(balances.status, (await getAsKey(`/v1/wallets/${TEST_WALLET_ID}`)).status);
    }

    expect(new Set(statuses)).toEqual(new Set([200]));
    const sampledWeights = [...Array.from({ length: 10 }, () => 1), 10, 10];
    for (const route of [BALANCES_ROUTE, WALLET_ROUTE]) {
      expect(
        accountReads()
          .filter((line) => line.route === route)
          .map((line) => line.sample_weight)
      ).toEqual(sampledWeights);
    }
    const requestId = balancesRequestIds[0];
    expect(accountReads()[0]).toEqual({
      level: 30,
      severity: "INFO",
      time: expect.any(Number),
      request_id: requestId,
      trace_id: requestId,
      route: BALANCES_ROUTE,
      event: "sdp_rpc_attempt",
      surface: "managed_pool",
      provider: "default",
      cluster: "devnet",
      method: "getAccountInfo",
      outcome: "succeeded",
      duration_ms: expect.any(Number),
      sample_weight: 1,
    });
  });

  it("logs every failed attempt and cooldown at weight 1 and puts the route on every line of the request", async () => {
    rpc.respond("getAccountInfo", () => ({
      error: { code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, message: "unhealthy" },
    }));

    for (let index = 0; index < 12; index += 1) {
      expect((await getAsKey(`/v1/wallets/${TEST_WALLET_ID}`)).status).toBe(503);
    }

    expect(
      accountReads().map((line) => ({
        event: line.event,
        outcome: line.outcome,
        sample_weight: line.sample_weight,
      }))
    ).toEqual(
      Array.from({ length: 12 }, () => [
        { event: "sdp_rpc_attempt", outcome: "failed", sample_weight: 1 },
        { event: "sdp_rpc_cooldown", sample_weight: 1 },
      ]).flat()
    );
    expect(accountReads().filter((line) => Object.hasOwn(line, "message"))).toEqual([]);
    expect(lines.filter((line) => line.event === "sdp_api_request_timing")).toHaveLength(12);
    expect(lines.filter((line) => line.route !== WALLET_ROUTE)).toEqual([]);
  });
});
