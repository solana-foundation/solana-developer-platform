import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { address, createSolanaRpcFromTransport, type RpcTransport } from "@solana/kit";
import {
  contextAwareRpcFetch,
  observeRpcRead,
  prepareRpcRead,
  withMinimumRpcSlot,
  withRpcReadContext,
} from "./read-context";

const request = {
  jsonrpc: "2.0",
  id: 1,
  method: "getMultipleAccounts",
  params: [["account"], { encoding: "base64", commitment: "finalized" }],
};
const answer = (slot: number | bigint) => ({ result: { context: { slot }, value: [] } });

describe("confirmed balance read contexts", () => {
  it("requires a chain context instead of treating a later HTTP request as fresh", async () => {
    await assert.rejects(
      withMinimumRpcSlot(101, async () => {
        observeRpcRead(request, answer(100));
        return "old balance";
      }),
      /behind/
    );
    await assert.rejects(
      withMinimumRpcSlot(101, async () => "cached balance"),
      /did not establish/
    );
  });

  it("allows unchanged balances once the returned slot covers the confirmation", async () => {
    const result = await withMinimumRpcSlot(101, async () => {
      observeRpcRead(request, answer(101n));
      return "10.00";
    });
    assert.equal(result, "10.00");
  });

  it("enforces the last of multiple same-vault confirmations", async () => {
    await assert.rejects(
      withMinimumRpcSlot(103, async () => observeRpcRead(request, answer(102))),
      /behind/
    );
    await withMinimumRpcSlot(103, async () => observeRpcRead(request, answer(103)));
  });

  it("does not accept a swallowed stale read after another account read succeeded", async () => {
    await assert.rejects(
      withMinimumRpcSlot(101, async () => {
        observeRpcRead(request, answer(102));
        try {
          observeRpcRead(request, answer(100));
        } catch {
          /* provider fallback */
        }
        return "old cached valuation";
      }),
      /did not establish/
    );
  });

  it("requests confirmed account state with minContextSlot without changing unscoped calls", async () => {
    assert.equal(prepareRpcRead(request), request);
    await withMinimumRpcSlot(101, async () => {
      assert.deepEqual(prepareRpcRead(request), {
        ...request,
        params: [["account"], { encoding: "base64", commitment: "confirmed", minContextSlot: 101 }],
      });
      observeRpcRead(request, answer(101));
    });
    assert.equal(prepareRpcRead(request), request);
  });

  it("validates token-balance response slots without sending an unsupported minContextSlot", async () => {
    const token = { ...request, method: "getTokenAccountBalance", params: ["account", {}] };
    await withMinimumRpcSlot(101, async () => {
      assert.deepEqual(prepareRpcRead(token), {
        ...token,
        params: ["account", { commitment: "confirmed" }],
      });
      observeRpcRead(token, answer(101));
    });
  });

  it("keeps concurrent request bounds isolated", async () => {
    await Promise.all(
      [101, 202].map((slot) =>
        withMinimumRpcSlot(slot, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          assert.deepEqual(prepareRpcRead(request), {
            ...request,
            params: [
              ["account"],
              { encoding: "base64", commitment: "confirmed", minContextSlot: slot },
            ],
          });
          observeRpcRead(request, answer(slot));
        })
      )
    );
  });

  it("rejects unvalidated batch requests even if the provider catches the error", async () => {
    await assert.rejects(
      withMinimumRpcSlot(101, async () => {
        observeRpcRead(request, answer(101));
        try {
          prepareRpcRead([request]);
        } catch {
          /* provider fallback */
        }
      }),
      /did not establish/
    );
  });

  it("validates direct JSON and web3 fetch responses instead of trusting HTTP success", async (t) => {
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.params[1].minContextSlot, 101);
        return Response.json(answer(100));
      }
    );
    try {
      await assert.rejects(
        withMinimumRpcSlot(101, () =>
          contextAwareRpcFetch("https://rpc.example", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ),
        /behind/
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("requests and verifies program account contexts", async () => {
    const program = { ...request, method: "getProgramAccounts", params: ["program", {}] };
    await withMinimumRpcSlot(101, async () => {
      assert.deepEqual(prepareRpcRead(program), {
        ...program,
        params: ["program", { commitment: "confirmed", minContextSlot: 101, withContext: true }],
      });
      observeRpcRead(program, answer(101));
    });
    await assert.rejects(
      withMinimumRpcSlot(101, async () => {
        observeRpcRead(request, answer(101));
        observeRpcRead(program, { result: [] });
      }),
      /behind/
    );
  });

  it("preserves the SDK array contract after validating a program-account context", async () => {
    const transport: RpcTransport = async <T>(config: Parameters<RpcTransport>[0]) => {
      assert.equal(
        (config.payload as { params: [string, { withContext: boolean }] }).params[1].withContext,
        true
      );
      return { jsonrpc: "2.0", id: 1, ...answer(101) } as T;
    };
    const rpc = createSolanaRpcFromTransport(withRpcReadContext(transport));
    await withMinimumRpcSlot(101, async () => {
      // Veda's listAssets calls .filter on this actual kit result.
      const accounts = await rpc
        .getProgramAccounts(address("11111111111111111111111111111111"), {
          encoding: "base64",
          withContext: false,
        })
        .send();
      assert.deepEqual(
        accounts.filter(() => true),
        []
      );
      const contextual = await rpc
        .getProgramAccounts(address("11111111111111111111111111111111"), {
          encoding: "base64",
          withContext: true,
        })
        .send();
      assert.equal(contextual.context.slot, 101n);
    });
  });

  it("preserves direct JSON program-account shape only after checking the slot", async (t) => {
    let slot = 101;
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json(answer(slot)));
    const program = {
      ...request,
      method: "getProgramAccounts",
      params: ["program", { withContext: false }],
    };
    try {
      await withMinimumRpcSlot(101, async () => {
        const response = await contextAwareRpcFetch("https://rpc.example", {
          method: "POST",
          body: JSON.stringify(program),
        });
        assert.deepEqual(await response.json(), { result: [] });
      });
      slot = 100;
      await assert.rejects(
        withMinimumRpcSlot(101, () =>
          contextAwareRpcFetch("https://rpc.example", {
            method: "POST",
            body: JSON.stringify(program),
          })
        ),
        /behind/
      );
    } finally {
      mock.mock.restore();
    }
  });

  it("refuses missing, malformed and unsafe context slots", async () => {
    for (const response of [
      { result: { value: [] } },
      answer(-1),
      answer(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      await assert.rejects(
        withMinimumRpcSlot(101, async () => observeRpcRead(request, response)),
        /behind/
      );
    }
  });
});
