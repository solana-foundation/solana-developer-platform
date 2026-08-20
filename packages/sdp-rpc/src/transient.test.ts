import assert from "node:assert/strict";
import test from "node:test";
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
