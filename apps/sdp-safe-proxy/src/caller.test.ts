import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { SafeProxyError } from "@sdp/safe-proxy-catalog/errors";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { type CallerCredentials, createCallerResolver, type ResolveCaller } from "@/caller";
import type { Settings } from "@/settings";

const AUDIENCE = "https://safe-proxy.example.com";

const googleSettings: Settings = {
  callerAuth: "google",
  port: 8080,
  audience: AUDIENCE,
  callerEmails: { api: "api@example.com", cron: "cron@example.com" },
};

async function assertNotAllowed(resolved: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(resolved, (error: unknown) => {
    assert.ok(error instanceof SafeProxyError, label);
    assert.equal(error.code, "caller_not_allowed", label);
    assert.equal(error.outcome, "rejected", label);
    return true;
  });
}

function credentials(fields: Partial<CallerCredentials>): CallerCredentials {
  return { authorization: undefined, localCaller: undefined, ...fields };
}

describe("createCallerResolver in local mode", () => {
  const resolve = createCallerResolver({ callerAuth: "local", port: 8791 });

  it("resolves the caller the header names", async () => {
    assert.equal(await resolve(credentials({ localCaller: "api" })), "api");
    assert.equal(await resolve(credentials({ localCaller: "cron" })), "cron");
  });

  it("refuses an absent, empty, unknown or differently cased caller name", async () => {
    for (const localCaller of [undefined, "", "worker", "API", "Cron", " api"]) {
      await assertNotAllowed(resolve(credentials({ localCaller })), `${localCaller}`);
    }
  });
});

describe("createCallerResolver in google mode", () => {
  const resolve = createCallerResolver(googleSettings);

  it("refuses a request with no authorization header, even when it names a local caller", async () => {
    await assertNotAllowed(resolve(credentials({})), "absent");
    await assertNotAllowed(resolve(credentials({ localCaller: "api" })), "local header");
  });

  it("refuses an authorization header that is not a bearer token", async () => {
    for (const authorization of ["", "Basic YXBpOnNlY3JldA==", "Bearer", "token-without-scheme"]) {
      await assertNotAllowed(resolve(credentials({ authorization })), authorization);
    }
  });
});

describe("createCallerResolver in google mode with a verified identity token", () => {
  let signingKey: CryptoKey;
  let resolve: ResolveCaller;

  before(async () => {
    const pair = await generateKeyPair("RS256");
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256" };
    resolve = createCallerResolver(googleSettings, createLocalJWKSet({ keys: [jwk] }));
  });

  async function bearer(email: string, audience: string): Promise<CallerCredentials> {
    const token = await new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(signingKey);
    return credentials({ authorization: `Bearer ${token}` });
  }

  it("maps the api and cron accounts to their callers", async () => {
    assert.equal(await resolve(await bearer("api@example.com", AUDIENCE)), "api");
    assert.equal(await resolve(await bearer("cron@example.com", AUDIENCE)), "cron");
  });

  it("refuses a verified token for any other account", async () => {
    await assertNotAllowed(resolve(await bearer("other@example.com", AUDIENCE)), "other");
  });

  it("refuses a token for the api account issued for another audience", async () => {
    const elsewhere = await bearer("api@example.com", "https://other.example.com");
    await assertNotAllowed(resolve(elsewhere), "audience");
  });
});
