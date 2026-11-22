import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { importSPKI, jwtVerify } from "jose";
import type { AuthRequest } from "./auth-service";
import { FireblocksAuthService } from "./fireblocks";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const credential = { apiKey: "fb-api-key-1", apiSecretPem: privateKey };
const service = new FireblocksAuthService();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function signedToken(request: AuthRequest) {
  const headers = await service.injectCredentials(credential, request);
  assert.ok(headers.Authorization, "injectCredentials returned no Authorization header");
  const token = headers.Authorization.replace(/^Bearer /, "");
  assert.deepEqual(headers, { Authorization: `Bearer ${token}`, "X-API-Key": "fb-api-key-1" });
  return jwtVerify(token, await importSPKI(publicKey, "RS256"));
}

describe("FireblocksAuthService", () => {
  it("signs the request target and body hash with a 30-second lifetime", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_750 });

    const { payload, protectedHeader } = await signedToken({
      path: "/v1/transactions?limit=5",
      body: '{"amount":"1.5"}',
    });

    assert.deepEqual(protectedHeader, { alg: "RS256" });
    const { nonce, ...claims } = payload;
    assert.match(String(nonce), UUID);
    assert.deepEqual(claims, {
      uri: "/v1/transactions?limit=5",
      bodyHash: "9770a8915fb5f83babcd8b6e1de2aa57378bb2cefe988f7f76f6f8aca095c548",
      sub: "fb-api-key-1",
      iat: 1_800_000_000,
      exp: 1_800_000_030,
    });
  });

  it("hashes an empty body as the empty string", async () => {
    const { payload } = await signedToken({ path: "/v1/vault/accounts", body: "" });

    assert.equal(
      payload.bodyHash,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("issues a different nonce on each call", async () => {
    const request = { path: "/v1/vault/accounts", body: "" };
    const first = await signedToken(request);
    const second = await signedToken(request);

    assert.match(String(first.payload.nonce), UUID);
    assert.notEqual(first.payload.nonce, second.payload.nonce);
  });

  it("rejects a credential whose key is not PKCS#8 without carrying the key text", async () => {
    const pkcs1 = createPrivateKey(privateKey).export({ type: "pkcs1", format: "pem" }).toString();
    const keyLines = pkcs1.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));

    await assert.rejects(
      service.injectCredentials(
        { ...credential, apiSecretPem: pkcs1 },
        { path: "/v1/vault/accounts", body: "" }
      ),
      (error: Error) => {
        const carried = [error.message, error.stack, String(error.cause)].join("\n");
        return keyLines.every((line) => !carried.includes(line));
      }
    );
  });
});
