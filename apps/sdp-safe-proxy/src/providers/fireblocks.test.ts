import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { it } from "node:test";
import { importSPKI, jwtVerify } from "jose";
import { FireblocksAuthService } from "./fireblocks";

it("signs a token over the request target and body that verifies against the public key", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_750 });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const headers = await new FireblocksAuthService().injectCredentials(
    { apiKey: "fb-api-key-1", apiSecretPem: privateKey },
    { path: "/v1/transactions?limit=5", body: '{"amount":"1.5"}' }
  );

  const { Authorization, ...rest } = headers;
  assert.deepEqual(rest, { "X-API-Key": "fb-api-key-1" });
  const token = /^Bearer (.+)$/.exec(Authorization ?? "")?.[1] ?? "";
  const { payload } = await jwtVerify(token, await importSPKI(publicKey, "RS256"));
  const { nonce, ...claims } = payload;
  assert.match(String(nonce), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(claims, {
    uri: "/v1/transactions?limit=5",
    bodyHash: "9770a8915fb5f83babcd8b6e1de2aa57378bb2cefe988f7f76f6f8aca095c548",
    sub: "fb-api-key-1",
    iat: 1_800_000_000,
    exp: 1_800_000_030,
  });
});
