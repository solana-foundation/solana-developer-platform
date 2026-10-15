import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { errors, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClerkKeysUnavailableError,
  isSigningKeyFetchFailure,
  verifyClerkJwt,
  warmClerkSigningKeys,
} from "@/lib/clerk-token";
import { ensureTestClerkIssuer, signTestClerkClaims } from "@/test/helpers/clerk";
import { env as testEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";

describe("isSigningKeyFetchFailure", () => {
  it.each([
    ["a rejected fetch", new TypeError("fetch failed")],
    ["a key set timeout", new errors.JWKSTimeout()],
    ["a malformed key set", new errors.JWKSInvalid()],
    [
      "a non-200 or unparseable response",
      new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response"),
    ],
  ])("treats %s as unreachable keys", (_label, error) => {
    expect(isSigningKeyFetchFailure(error)).toBe(true);
  });

  it.each([
    ["an unknown key id", new errors.JWKSNoMatchingKey()],
    ["several matching keys", new errors.JWKSMultipleMatchingKeys()],
    ["a bad signature", new errors.JWSSignatureVerificationFailed()],
    ["an expired token", new errors.JWTExpired("expired", {})],
    ["a malformed token", new errors.JWSInvalid("malformed")],
  ])("treats %s as a verdict on the token", (_label, error) => {
    expect(isSigningKeyFetchFailure(error)).toBe(false);
  });
});

describe("Clerk signing key resolution", () => {
  const servers: Server[] = [];

  async function closeServers(): Promise<void> {
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      })
    );
  }

  afterEach(closeServers);

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    const address = server.address();
    assert(address !== null && typeof address === "object");
    return `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
  }

  async function refusedJwksUrl(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address !== null && typeof address === "object");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
  }

  async function envWithJwks(jwksUrl: string): Promise<Env> {
    const { issuer } = await ensureTestClerkIssuer({ ...testEnv });
    return { ...testEnv, CLERK_ISSUER: issuer, CLERK_JWKS_URL: jwksUrl };
  }

  async function verificationError(token: string, env: Env): Promise<Error> {
    return verifyClerkJwt(token, env).then(
      () => assert.fail("expected verification to fail"),
      (cause: unknown) => {
        assert(cause instanceof Error);
        return cause;
      }
    );
  }

  it("reports a refused connection to the key set as unreachable keys", async () => {
    const env = await envWithJwks(await refusedJwksUrl());
    const token = await signTestClerkClaims({ sub: "user_refused" }, 300);

    const error = await verificationError(token, env);

    assert(error instanceof ClerkKeysUnavailableError);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("reports a key set that answers 500 as unreachable keys", async () => {
    const env = await envWithJwks(
      await listen((_request, response) => {
        response.writeHead(500);
        response.end();
      })
    );
    const token = await signTestClerkClaims({ sub: "user_500" }, 300);

    const error = await verificationError(token, env);

    assert(error instanceof ClerkKeysUnavailableError);
    expect(error.cause).toBeInstanceOf(errors.JOSEError);
  });

  it("keeps a token signed with a key the reachable set does not hold an invalid token", async () => {
    const { issuer, jwksUrl } = await ensureTestClerkIssuer({ ...testEnv });
    const env = { ...testEnv, CLERK_ISSUER: issuer, CLERK_JWKS_URL: jwksUrl };
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "user_foreign_key" })
      .setProtectedHeader({ alg: "RS256", kid: "not_in_the_set" })
      .setIssuer(issuer)
      .setExpirationTime("5m")
      .sign(privateKey);

    expect(await verificationError(token, env)).toBeInstanceOf(errors.JWKSNoMatchingKey);
  });

  it("keeps an expired token an invalid token", async () => {
    const { issuer, jwksUrl } = await ensureTestClerkIssuer({ ...testEnv });
    const token = await signTestClerkClaims({ sub: "user_expired" }, -60);

    const error = await verificationError(token, {
      ...testEnv,
      CLERK_ISSUER: issuer,
      CLERK_JWKS_URL: jwksUrl,
    });

    expect(error).toBeInstanceOf(errors.JWTExpired);
  });

  it("warms the cache verification reads, so a later key set outage does not fail it", async () => {
    const { jwksUrl: sharedJwksUrl } = await ensureTestClerkIssuer({ ...testEnv });
    const jwks = await (await fetch(sharedJwksUrl)).text();
    const jwksUrl = await listen((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(jwks);
    });
    const env = await envWithJwks(jwksUrl);

    await warmClerkSigningKeys(env);
    await closeServers();

    const token = await signTestClerkClaims({ sub: "user_warmed" }, 300);
    await expect(verifyClerkJwt(token, env)).resolves.toMatchObject({ sub: "user_warmed" });
  });

  it("rejects the warmup probe while the key set is unreachable", async () => {
    const env = await envWithJwks(await refusedJwksUrl());

    await expect(warmClerkSigningKeys(env)).rejects.toThrow("fetch failed");
  });
});
