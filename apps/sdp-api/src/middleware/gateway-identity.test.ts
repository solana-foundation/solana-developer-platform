import assert from "node:assert/strict";
import { createServer } from "node:http";
import { hashString } from "@sdp/payments/hash";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { generateSfApiKey } from "@/lib/api-key-format";
import {
  GATEWAY_AUDIENCE,
  GATEWAY_IDENTITY_HEADER,
  resolveGatewayIdentityConfig,
} from "@/lib/gateway-identity";
import { TEST_REVOKED_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const kid = "gateway_test_es256";
const CLIENT_IP = "203.0.113.5";

let issuer: string;
let jwksUrl: string;
let signingKey: CryptoKey;
let closeIssuer: () => Promise<void>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  signingKey = privateKey;
  const jwks = JSON.stringify({
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }],
  });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/.well-known/jwks.json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(jwks);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  issuer = `http://127.0.0.1:${address.port}`;
  jwksUrl = `${issuer}/.well-known/jwks.json`;
  closeIssuer = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await closeIssuer();
});

function gatewayEnv(): Env {
  return { ...env, SF_GATEWAY_ISSUER: issuer, SF_GATEWAY_JWKS_URL: jwksUrl };
}

async function identityToken(
  claims: JWTPayload,
  options: { key?: CryptoKey; alg?: string; audience?: string; issuer?: string; iat?: number } = {}
): Promise<string> {
  const iat = options.iat ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ project_id: "prj_gateway", client_ip: CLIENT_IP, ...claims })
    .setProtectedHeader({ alg: options.alg ?? "ES256", kid })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? GATEWAY_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .sign(options.key ?? signingKey);
}

function request(headers: Record<string, string>, bindings: Env = gatewayEnv()) {
  return app.request(
    `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
    { headers },
    bindings
  );
}

describe("gateway identity (X-SF-Identity)", () => {
  const sfKey = generateSfApiKey();

  async function seedSfKey(overrides: Partial<typeof TEST_SEEDED_API_KEY> = {}) {
    await seedApiKeyRow(env, await hashString(sfKey.secret, env.API_KEY_PEPPER), {
      ...TEST_SEEDED_API_KEY,
      ...overrides,
      publicId: sfKey.keyId,
    });
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
      .run();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("ignores the header when no gateway is configured", async () => {
    await seedSfKey();
    const token = await identityToken({ key_id: sfKey.keyId });

    const res = await request({ [GATEWAY_IDENTITY_HEADER]: token }, env);

    expect(res.status).toBe(401);
    expect(errorBodySchema.parse(await res.json()).error.message).toBe("API key required");
  });

  it("authenticates the key the gateway names, with no key presented", async () => {
    await seedSfKey();

    const res = await request({
      [GATEWAY_IDENTITY_HEADER]: await identityToken({ key_id: sfKey.keyId }),
    });

    expect(res.status).toBe(200);
  });

  it("still accepts a key presented directly, without the header", async () => {
    await seedSfKey();

    const res = await request({ Authorization: `Bearer ${sfKey.key}` });

    expect(res.status).toBe(200);
  });

  it("accepts a presented key that matches the identity", async () => {
    await seedSfKey();

    const res = await request({
      Authorization: `Bearer ${sfKey.key}`,
      [GATEWAY_IDENTITY_HEADER]: await identityToken({ key_id: sfKey.keyId }),
    });

    expect(res.status).toBe(200);
  });

  it("refuses a presented key that is not the one the identity names", async () => {
    await seedSfKey();
    const other = generateSfApiKey();

    const res = await request({
      Authorization: `Bearer ${sfKey.key}`,
      [GATEWAY_IDENTITY_HEADER]: await identityToken({ key_id: other.keyId }),
    });

    expect(res.status).toBe(401);
    expect(errorBodySchema.parse(await res.json()).error).toEqual({
      code: "INVALID_API_KEY",
      message: "API key does not match the gateway identity",
    });
  });

  it("refuses a revoked key the gateway still names", async () => {
    await seedSfKey({ status: TEST_REVOKED_KEY.status });

    const res = await request({
      [GATEWAY_IDENTITY_HEADER]: await identityToken({ key_id: sfKey.keyId }),
    });

    expect(res.status).toBe(401);
    expect(errorBodySchema.parse(await res.json()).error.code).toBe("REVOKED_API_KEY");
  });

  it("refuses a key ID that names no key", async () => {
    await seedSfKey();

    const res = await request({
      [GATEWAY_IDENTITY_HEADER]: await identityToken({ key_id: generateSfApiKey().keyId }),
    });

    expect(res.status).toBe(401);
    expect(errorBodySchema.parse(await res.json()).error.code).toBe("INVALID_API_KEY");
  });

  it("checks the key's IP allowlist against the identity's client_ip, not forwarding headers", async () => {
    await seedSfKey({ allowedIps: [CLIENT_IP] });

    const allowed = await request({
      [GATEWAY_IDENTITY_HEADER]: await identityToken({ key_id: sfKey.keyId }),
      "X-Forwarded-For": "198.51.100.1, 198.51.100.2",
    });
    const refused = await request({
      [GATEWAY_IDENTITY_HEADER]: await identityToken({
        key_id: sfKey.keyId,
        client_ip: "198.51.100.9",
      }),
      "X-Forwarded-For": `${CLIENT_IP}, 198.51.100.2`,
    });

    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(403);
  });

  describe("refuses an identity that does not verify, never falling back to the key", () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ["for another app", () => identityToken({ key_id: sfKey.keyId }, { audience: "tokens" })],
      [
        "from another issuer",
        () => identityToken({ key_id: sfKey.keyId }, { issuer: "https://elsewhere.test" }),
      ],
      [
        "older than 60 seconds",
        () => identityToken({ key_id: sfKey.keyId }, { iat: Math.floor(Date.now() / 1000) - 120 }),
      ],
      [
        "signed by another key",
        async () =>
          identityToken(
            { key_id: sfKey.keyId },
            { key: (await generateKeyPair("ES256")).privateKey }
          ),
      ],
      [
        "signed with RS256",
        async () =>
          identityToken(
            { key_id: sfKey.keyId },
            { key: (await generateKeyPair("RS256")).privateKey, alg: "RS256" }
          ),
      ],
      ["without a client_ip", () => identityToken({ key_id: sfKey.keyId, client_ip: undefined })],
      [
        "naming both a key and a user",
        () => identityToken({ key_id: sfKey.keyId, clerk_user_id: "user_1" }),
      ],
      ["that is not a JWT", async () => "not-a-jwt"],
    ];

    it.each(cases)("%s", async (_name, token) => {
      await seedSfKey();

      const res = await request({
        Authorization: `Bearer ${sfKey.key}`,
        [GATEWAY_IDENTITY_HEADER]: await token(),
      });

      expect(res.status).toBe(401);
      expect(errorBodySchema.parse(await res.json()).error).toEqual({
        code: "UNAUTHORIZED",
        message: "Invalid gateway identity",
      });
    });
  });
});

describe("resolveGatewayIdentityConfig", () => {
  it("is null with neither key, and refuses one without the other", () => {
    expect(resolveGatewayIdentityConfig({})).toBeNull();
    expect(() => resolveGatewayIdentityConfig({ SF_GATEWAY_ISSUER: "https://gw.test" })).toThrow(
      "SF_GATEWAY_ISSUER and SF_GATEWAY_JWKS_URL must be set together"
    );
    expect(() =>
      resolveGatewayIdentityConfig({ SF_GATEWAY_JWKS_URL: "https://gw.test/jwks.json" })
    ).toThrow("SF_GATEWAY_ISSUER and SF_GATEWAY_JWKS_URL must be set together");
  });
});
