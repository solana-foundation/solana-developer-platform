import assert from "node:assert/strict";
import test from "node:test";
import { depositAndTrack, type SavedRequest } from "./earn.ts";

for (const connected of [false, true]) {
  test(
    connected
      ? "connected wallet submits without signed bytes"
      : "caller signs without SDP wallet registration",
    async () => {
      const requests: Array<{ path: string; init?: RequestInit }> = [];
      const saved: SavedRequest[] = [];
      let signed = false;
      let reviewed = false;
      const operation = {
        id: "operation/one",
        actionId: "action",
        version: 1,
        status: "prepared",
        terms: { fees: [] },
        nextAction: connected
          ? { type: "submit" }
          : { type: "sign_transaction", transaction: "unsigned" },
      };
      const result = await depositAndTrack({
        apiUrl: "https://api.example.invalid",
        apiKey: "server-key",
        deposit: {
          strategyId: "strategy",
          source: connected ? { walletId: "wallet" } : { ownerAddress: "owner" },
          amount: { mint: "usdc", value: "10" },
        },
        keys: { prepare: "prepare-key", submit: "submit-key" },
        save: async (request) => {
          saved.push(request);
        },
        review: async () => {
          reviewed = true;
        },
        signTransaction: async (unsigned) => {
          assert.equal(unsigned, "unsigned");
          signed = true;
          return "exact-signed-bytes";
        },
        observe: () => {},
        wait: async () => {},
        fetchRequest: async (url, init) => {
          const path = new URL(String(url)).pathname;
          requests.push({ path, init });
          if (path.endsWith("/deposit"))
            return Response.json({ data: { operation } }, { status: 202 });
          if (path.endsWith("/submit")) {
            assert.equal(reviewed, true);
            assert.equal(saved.length, 2);
            return Response.json(
              {
                data: {
                  operation: { ...operation, status: "queued", nextAction: { type: "wait" } },
                },
              },
              { status: 202 }
            );
          }
          return Response.json({
            data: { operation: { ...operation, status: "completed", nextAction: null } },
          });
        },
      });
      assert.equal(result.status, "completed");
      assert.equal(signed, !connected);
      assert.deepEqual(
        requests.map((request) => request.path),
        [
          "/v1/earn/deposit",
          "/v1/operations/operation%2Fone/submit",
          "/v1/operations/operation%2Fone",
        ]
      );
      assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
        actionId: "action",
        version: 1,
        ...(connected ? {} : { signedTransaction: "exact-signed-bytes" }),
      });
      assert.equal(new Headers(requests[1]?.init?.headers).get("Idempotency-Key"), "submit-key");
      assert.equal(
        new Headers(requests[0]?.init?.headers).get("Authorization"),
        "Bearer server-key"
      );
    }
  );
}

test("storage failure prevents preparation", async () => {
  let requests = 0;
  await assert.rejects(
    depositAndTrack({
      apiUrl: "https://api.example.invalid",
      apiKey: "key",
      deposit: {
        strategyId: "strategy",
        source: { ownerAddress: "owner" },
        amount: { mint: "usdc", value: "10" },
      },
      keys: { prepare: "prepare", submit: "submit" },
      save: async () => {
        throw new Error("Storage unavailable");
      },
      review: async () => {},
      observe: () => {},
      fetchRequest: async () => {
        requests += 1;
        return new Response();
      },
    }),
    /Storage unavailable/
  );
  assert.equal(requests, 0);
});
