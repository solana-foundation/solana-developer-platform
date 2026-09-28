import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultRpcTransport,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SolanaError,
} from "@solana/kit";
import { solanaRpcError } from "./errors";
import { isTransientRpcError, withTransientRpcRetry } from "./transient";

async function kitHttpError(status: number, statusText: string): Promise<unknown> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status, statusText })) as typeof fetch;
  try {
    const transport = createDefaultRpcTransport({ url: "https://rpc.example.test" });
    await transport({ payload: { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] } });
  } catch (error) {
    return error;
  } finally {
    globalThis.fetch = originalFetch;
  }
  throw new Error("expected the HTTP transport to reject");
}

test("classifies Kit HTTP transport errors by status code", async () => {
  const transient: Array<[number, string]> = [
    [408, "Request Timeout"],
    [429, "Too Many Requests"],
    [500, "Internal Server Error"],
    [502, "Bad Gateway"],
    [503, "Service Unavailable"],
    [504, "Gateway Timeout"],
    [503, ""],
  ];
  for (const [status, statusText] of transient) {
    assert.equal(isTransientRpcError(await kitHttpError(status, statusText)), true, `${status}`);
  }
  const persistent: Array<[number, string]> = [
    [400, "Bad Request"],
    [401, "Unauthorized"],
    [403, "Forbidden"],
    [404, "Not Found"],
    [413, "Payload Too Large"],
    [425, "Too Early"],
  ];
  for (const [status, statusText] of persistent) {
    assert.equal(isTransientRpcError(await kitHttpError(status, statusText)), false, `${status}`);
  }
});

test("ignores HTTP status numbers in the text of non-HTTP errors", () => {
  assert.equal(isTransientRpcError(new Error("transfer of 503 lamports failed")), false);
  assert.equal(isTransientRpcError(new Error("HTTP error (500): Internal server error")), false);
  assert.equal(isTransientRpcError(new Error("503")), false);
  assert.equal(isTransientRpcError("429"), false);
});

test("still classifies network-level failures as transient", () => {
  assert.equal(isTransientRpcError(new TypeError("fetch failed")), true);
  assert.equal(isTransientRpcError(new Error("socket hang up")), true);
  assert.equal(isTransientRpcError(new Error("read ECONNRESET")), true);
  assert.equal(
    isTransientRpcError(solanaRpcError("RPC request timed out after 25ms", { timedOut: true })),
    true
  );
  assert.equal(isTransientRpcError(new Error("503 Service Unavailable")), true);
  assert.equal(isTransientRpcError(new Error("Blockhash not found")), false);
});

test("retries a transient error and returns the eventual success", async () => {
  let calls = 0;
  const result = await withTransientRpcRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error("fetch failed");
    return "ok";
  }, [0, 0, 0]);
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("does not retry a persistent error", async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRpcRetry(async () => {
      calls += 1;
      throw new Error("Blockhash not found");
    }, [0, 0, 0]),
    /Blockhash not found/
  );
  assert.equal(calls, 1);
});

test("stops retrying once the elapsed budget is spent", async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRpcRetry(
      async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new Error("fetch failed");
      },
      [0, 0, 0, 0],
      { maxElapsedMs: 60 }
    ),
    /fetch failed/
  );
  assert.equal(calls, 2);
});

test("fast transient failures use the whole schedule within the budget", async () => {
  let calls = 0;
  const result = await withTransientRpcRetry(
    async () => {
      calls += 1;
      if (calls < 4) throw new Error("fetch failed");
      return "ok";
    },
    [0, 0, 0],
    { maxElapsedMs: 60_000 }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 4);
});

test("retries a long-term-storage server error", async () => {
  let calls = 0;
  const result = await withTransientRpcRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE);
    }
    return "ok";
  }, [0, 0, 0]);
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("retries an unhealthy-node server error", async () => {
  let calls = 0;
  const result = await withTransientRpcRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, {
        numSlotsBehind: 100,
      });
    }
    return "ok";
  }, [0, 0, 0]);
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("does not retry a plain error whose text merely resembles a server code", async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRpcRetry(async () => {
      calls += 1;
      throw new Error("custom program error: 0x32019");
    }, [0, 0, 0]),
    /custom program error/
  );
  assert.equal(calls, 1);
});

test("gives up after exhausting the delay schedule", async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRpcRetry(async () => {
      calls += 1;
      throw new Error("503 Service Unavailable");
    }, [0, 0]),
    /503/
  );
  assert.equal(calls, 3);
});

test("retries a Kit HTTP 503 until it succeeds", async () => {
  const unavailable = await kitHttpError(503, "");
  let calls = 0;
  const result = await withTransientRpcRetry(async () => {
    calls += 1;
    if (calls === 1) throw unavailable;
    return "ok";
  }, [0, 0, 0]);
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("does not retry a Kit HTTP 400", async () => {
  const badRequest = await kitHttpError(400, "Bad Request");
  let calls = 0;
  await assert.rejects(
    withTransientRpcRetry(async () => {
      calls += 1;
      throw badRequest;
    }, [0, 0, 0]),
    (error) => error === badRequest
  );
  assert.equal(calls, 1);
});
