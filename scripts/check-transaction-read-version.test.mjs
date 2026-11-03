import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource } from "./check-transaction-read-version.mjs";

const file = "apps/sdp-api/src/services/example.ts";

test("requires the shared version on direct transaction reads", () => {
  assert.deepEqual(
    checkSource(
      "rpc.getTransaction(signature, { maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION });",
      file
    ),
    []
  );
  assert.match(checkSource("rpc.getTransaction(signature);", file)[0], /must use/);
  assert.match(
    checkSource("rpc.getTransaction(signature, { encoding: 'base64' });", file)[0],
    /must use/
  );
  assert.match(
    checkSource(
      "rpc.getTransaction(signature, { nested: { maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION } });",
      file
    )[0],
    /must use/
  );
});

test("rejects an explicit v0 cap", () => {
  const violations = checkSource(
    "rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0 });",
    file
  );
  assert.equal(violations.length, 2);
  assert.match(violations.join("\n"), /v0-only/);
});

test("checks generic JSON-RPC transaction reads", () => {
  assert.deepEqual(
    checkSource(
      "rpcRequest(runtime, 'getTransaction', [signature, { maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION }]);",
      file
    ),
    []
  );
  assert.match(
    checkSource("rpcRequest(runtime, 'getTransaction', [signature]);", file)[0],
    /must use/
  );
});

test("allows reviewed adapters and ignores test doubles", () => {
  assert.deepEqual(
    checkSource(
      "input.getTransaction(signature);",
      "apps/sdp-api/src/services/jobs/reconcile-sponsorship-budgets.ts"
    ),
    []
  );
  assert.match(checkSource("input.getTransaction(signature);", file)[0], /must use/);
  assert.deepEqual(checkSource("vi.spyOn(rpc, 'getTransaction');", file), []);
});
