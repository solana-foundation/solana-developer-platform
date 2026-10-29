import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultRpcTransport,
  getSolanaErrorFromJsonRpcError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SolanaError,
} from "@solana/kit";
import { RpcHttpStatusError, RpcTimeoutError } from "./errors";
import { fetchFailedError } from "./test-fixtures";
import {
  isForbiddenRpcError,
  isRpcUpstreamUnavailable,
  isTransientRpcError,
  isUnauthorizedRpcError,
  transientJsonRpcVerdict,
  withTransientRpcRetry,
} from "./transient";

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

test("classifies SDP's own guarded-transport status errors like kit's", () => {
  // The guarded transports (customer RPC, Private Channels gateway) throw
  // RpcHttpStatusError where kit's transport throws a SolanaError; the
  // classifiers must treat the two shapes identically.
  assert.equal(isTransientRpcError(new RpcHttpStatusError(503, "down")), true);
  assert.equal(isTransientRpcError(new RpcHttpStatusError(429, "slow down")), true);
  assert.equal(isTransientRpcError(new RpcHttpStatusError(401, "no")), false);
  assert.equal(isUnauthorizedRpcError(new RpcHttpStatusError(401, "expired token")), true);
  assert.equal(isUnauthorizedRpcError(new RpcHttpStatusError(403, "forbidden")), false);
  assert.equal(isForbiddenRpcError(new RpcHttpStatusError(403, "not owned by caller")), true);
  assert.equal(isForbiddenRpcError(new RpcHttpStatusError(401, "expired token")), false);
});

test("classifies connection failures by their code, never their text", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
    assert.equal(isTransientRpcError(fetchFailedError(code)), true, code);
    // A caller walking a cause chain meets the socket error itself.
    assert.equal(isTransientRpcError(Object.assign(new Error("closed"), { code })), true, code);
  }
  assert.equal(isTransientRpcError(fetchFailedError("ENOTFOUND")), false);
  assert.equal(isTransientRpcError(new DOMException("deadline", "TimeoutError")), true);
  assert.equal(isTransientRpcError(new DOMException("caller left", "AbortError")), false);
  assert.equal(isTransientRpcError(new RpcTimeoutError(25)), true);
  // Text alone proves nothing: these matched the old message regex.
  assert.equal(isTransientRpcError(new TypeError("fetch failed")), false);
  assert.equal(isTransientRpcError(new Error("socket hang up")), false);
  assert.equal(isTransientRpcError(new Error("503 Service Unavailable")), false);
  assert.equal(isTransientRpcError(new Error("Blockhash not found")), false);
});

const TRANSIENT_JSON_RPC_ERRORS = [
  { code: -32603, message: "Request timed out" },
  { code: -32005, message: "Node is unhealthy", data: { numSlotsBehind: 42 } },
  { code: -32011, message: "Transaction history is not available from this node" },
  { code: -32014, message: "Block status not yet available for slot 1" },
  { code: -32016, message: "Minimum context slot has not been reached", data: { contextSlot: 9 } },
  { code: -32019, message: "Failed to query long-term storage; please try again" },
];

const PERSISTENT_JSON_RPC_ERRORS = [
  { code: -32602, message: "Invalid params" },
  { code: -32002, message: "Transaction simulation failed", data: { err: "BlockhashNotFound" } },
  { code: -32003, message: "Transaction signature verification failure" },
];

/**
 * Each JSON-RPC error as kit raises it, decoded under `nodeEnv`. Kit reads `NODE_ENV` when it
 * builds the message, so production errors carry `Solana error #<code>` instead of the text.
 */
function decodedUnder(nodeEnv: string, errors: readonly { code: number; message: string }[]) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return errors.map((error) => getSolanaErrorFromJsonRpcError(error));
  } finally {
    process.env.NODE_ENV = previous;
  }
}

test("classifies JSON-RPC errors the same with production-stripped messages", () => {
  for (const nodeEnv of ["production", "test"]) {
    for (const error of decodedUnder(nodeEnv, TRANSIENT_JSON_RPC_ERRORS)) {
      assert.equal(isTransientRpcError(error), true, `${nodeEnv}: ${error.message}`);
    }
    for (const error of decodedUnder(nodeEnv, PERSISTENT_JSON_RPC_ERRORS)) {
      assert.equal(isTransientRpcError(error), false, `${nodeEnv}: ${error.message}`);
    }
  }
  // The premise: production messages hold no text a message check could match.
  const [timeout] = decodedUnder("production", TRANSIENT_JSON_RPC_ERRORS);
  assert.match(timeout.message, /^Solana error #-32603;/);
});

test("classifies a kit HTTP error by status with production-stripped messages", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const unavailable = await kitHttpError(503, "Service Unavailable");
    assert.doesNotMatch((unavailable as Error).message, /Service Unavailable/);
    assert.equal(isTransientRpcError(unavailable), true);
    assert.equal(isTransientRpcError(await kitHttpError(401, "Unauthorized")), false);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("gives the pool's failover codes a failover verdict and -32603 a retry verdict", () => {
  const verdicts = decodedUnder("production", TRANSIENT_JSON_RPC_ERRORS).map((error) =>
    transientJsonRpcVerdict(error)
  );
  assert.deepEqual(verdicts, ["retry", "failover", "failover", "failover", "failover", "failover"]);
  assert.equal(transientJsonRpcVerdict(new Error("Node is unhealthy")), undefined);
});

test("retries a transient error and returns the eventual success", async () => {
  let calls = 0;
  const result = await withTransientRpcRetry(async () => {
    calls += 1;
    if (calls < 3) throw fetchFailedError();
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

test("stops retrying once the elapsed budget is spent", async (t) => {
  // Each call takes 40 ms of a fake clock, so a slow runner cannot spend the
  // 60 ms budget inside the first call.
  let now = 0;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  await assert.rejects(
    withTransientRpcRetry(
      async () => {
        calls += 1;
        now += 40;
        throw fetchFailedError();
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
      if (calls < 4) throw fetchFailedError();
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
      throw new RpcHttpStatusError(503, "down");
    }, [0, 0]),
    /down/
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

test("names only RPC-sourced transient failures upstream-unavailable", async () => {
  assert.equal(isRpcUpstreamUnavailable(await kitHttpError(429, "Too Many Requests")), true);
  assert.equal(isRpcUpstreamUnavailable(new RpcTimeoutError(25)), true);
  assert.equal(isRpcUpstreamUnavailable(new RpcHttpStatusError(503, "down")), true);
  const [timeout] = decodedUnder("production", TRANSIENT_JSON_RPC_ERRORS);
  assert.equal(isRpcUpstreamUnavailable(timeout), true);
  // Persistent RPC errors and bare network errors (any `fetch` could have thrown) stay out.
  assert.equal(isRpcUpstreamUnavailable(await kitHttpError(401, "Unauthorized")), false);
  assert.equal(isRpcUpstreamUnavailable(fetchFailedError()), false);
  assert.equal(isRpcUpstreamUnavailable(new Error("503")), false);
});
