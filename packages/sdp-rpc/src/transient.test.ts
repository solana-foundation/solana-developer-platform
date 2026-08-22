import assert from "node:assert/strict";
import test from "node:test";
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SolanaError,
} from "@solana/kit";
import { withTransientRpcRetry } from "./transient";

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
