import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { test } from "node:test";
import { FireblocksApiError } from "./fireblocks-http";
import { readFireblocksPolicy } from "./fireblocks-policy";
import type { CustodyProvisioningRuntime } from "./runtime";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function access() {
  return {
    apiBaseUrl: "https://fireblocks.example.test",
    apiKey: crypto.randomUUID(),
    apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    vaultAccountId: "0",
    assetId: "SOL" as const,
  };
}
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
const envelope = {
  policy: { rules: [], metadata: {} },
  validation: { status: "SUCCESS", checkResult: { errors: 0, results: [] } },
};
test("shares successful policy reads and supports a fresh read", async () => {
  let calls = 0;
  const credentials = access();
  const rt = runtime(async (url, init) => {
    assert.equal(new URL(String(url)).searchParams.get("policyType"), "TRANSFER");
    assert.equal(init?.method, "GET");
    const jwt = new Headers(init?.headers).get("Authorization")?.split(".")[1];
    assert.ok(jwt);
    const payload = JSON.parse(Buffer.from(jwt, "base64url").toString());
    assert.equal(payload.uri, new URL(String(url)).pathname + new URL(String(url)).search);
    assert.equal(payload.sub, credentials.apiKey);
    calls++;
    return Response.json(envelope);
  });
  const values = await Promise.all([
    readFireblocksPolicy(rt, credentials),
    readFireblocksPolicy(rt, credentials),
  ]);
  assert.equal(calls, 1);
  assert.ok(values.every((v) => v.valid));
  await readFireblocksPolicy(rt, credentials, true);
  assert.equal(calls, 2);
});
test("denial and malformed responses never become cached empty policies", async () => {
  const credentials = access();
  let calls = 0;
  const rt = runtime(async () => {
    calls++;
    return calls === 1
      ? Response.json({}, { status: 403 })
      : calls === 2
        ? Response.json({ policy: {} })
        : Response.json(envelope);
  });
  await assert.rejects(readFireblocksPolicy(rt, credentials), FireblocksApiError);
  await assert.rejects(readFireblocksPolicy(rt, credentials));
  assert.equal((await readFireblocksPolicy(rt, credentials)).valid, true);
  assert.equal(calls, 3);
});
test("nonzero validation errors and unvalidated policies cannot be treated as valid", async () => {
  for (const validation of [
    { status: "INVALID_CONFIGURATION", checkResult: { errors: 1, results: [] } },
    { status: "UNVALIDATED", checkResult: { errors: 0, results: [] } },
  ]) {
    const value = await readFireblocksPolicy(
      runtime(async () => Response.json({ ...envelope, validation })),
      access()
    );
    assert.equal(value.valid, false);
  }
});
