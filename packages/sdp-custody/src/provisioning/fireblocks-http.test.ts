import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { describe, it } from "vitest";
import { FireblocksApiError, fireblocksRequest } from "./fireblocks-http";
import type { CustodyProvisioningRuntime } from "./runtime";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const params = {
  apiBaseUrl: "https://fireblocks.example.test",
  apiKey: "test-api-user",
  apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  method: "POST" as const,
  uri: "/v1/transactions",
  body: { operation: "TRANSFER", assetId: "SOL" },
};
function runtime(fetch: CustodyProvisioningRuntime["fetch"]): CustodyProvisioningRuntime {
  return {
    fetch,
    sleep: async () => {},
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (data) => webcrypto.getRandomValues(new Uint8Array(data)),
    sha256: async (data) => webcrypto.subtle.digest("SHA-256", new Uint8Array(data)),
  };
}

describe("Fireblocks HTTP contract", () => {
  it("keeps retries stable and separate requests distinct within the 40-character limit", async () => {
    const keys: string[] = [];
    const rt = runtime(async (_url, init) => {
      const key = new Headers(init?.headers).get("Idempotency-Key");
      assert.ok(key && key.length <= 40, "Fireblocks rejects longer keys with HTTP 400 / 9003");
      assert.deepEqual(JSON.parse(String(init?.body)), params.body);
      keys.push(key);
      return Response.json({ id: "transaction" });
    });
    const request = "payment-cf0c4bee-ff03-4112-9ebf-2b84be8126a6";
    for (const suffix of ["first", "first", "second"])
      await fireblocksRequest(rt, { ...params, idempotencyKey: `${request}-${suffix}` });
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    // Existing valid payment keys must not change after deploying this fix.
    const paymentKey = "xfr_9246a4cf-86f4-415b-b91c-1d9f4d11eed8";
    await fireblocksRequest(rt, { ...params, idempotencyKey: paymentKey });
    assert.equal(keys[3], paymentKey);
  });

  it("retains numeric error codes and request IDs without retaining provider message text", async () => {
    await assert.rejects(
      fireblocksRequest(
        runtime(async () =>
          Response.json(
            { code: 9003, message: "sensitive provider text" },
            { status: 400, headers: { "x-request-id": "provider-request-123" } }
          )
        ),
        params
      ),
      (error: unknown) => {
        assert.ok(error instanceof FireblocksApiError);
        assert.equal(error.status, 400);
        assert.equal(error.providerCode, 9003);
        assert.equal(error.requestId, "provider-request-123");
        assert.ok(!JSON.stringify(error).includes("sensitive provider text"));
        assert.ok(!error.message.includes("sensitive provider text"));
        return true;
      }
    );
  });

  it("preserves HTTP failure classification when error details are missing or malformed", async () => {
    for (const response of [
      new Response("upstream error", { status: 403 }),
      Response.json({ code: "sensitive provider text" }, { status: 403 }),
    ]) {
      await assert.rejects(
        fireblocksRequest(
          runtime(async () => response),
          params
        ),
        (error) => {
          assert.ok(error instanceof FireblocksApiError);
          assert.equal(error.status, 403);
          assert.equal(error.providerCode, undefined);
          return true;
        }
      );
    }
  });
});
