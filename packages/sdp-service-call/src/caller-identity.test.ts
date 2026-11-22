import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import {
  type CallerIdentity,
  CallerIdentityError,
  type CallerIdentityErrorCode,
  createCallerIdentityVerifier,
} from "./caller-identity";

const AUDIENCE = "https://callee.mock.invalid";
const ISSUER = "https://accounts.google.com";
const EMAIL = "caller@service-account.mock.invalid";
const ISSUED_AT = 1_800_000_000;
const MAX_TOKEN_AGE_SECONDS = 300;

let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let keys: JWTVerifyGetKey;

before(async () => {
  const trusted = await generateKeyPair("RS256");
  signingKey = trusted.privateKey;
  otherSigningKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = await exportJWK(trusted.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", kid: "current" }] });
});

function signToken(
  options: {
    claims?: JWTPayload;
    audience?: string;
    issuer?: string;
    issuedAt?: number | null;
    expiresAt?: number;
    kid?: string;
    key?: CryptoKey;
  } = {}
): Promise<string> {
  const jwt = new SignJWT(options.claims ?? { email: EMAIL, email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "current" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresAt ?? ISSUED_AT + 3600);
  if (options.issuedAt !== null) jwt.setIssuedAt(options.issuedAt ?? ISSUED_AT);
  return jwt.sign(options.key ?? signingKey);
}

function verify(
  header: string | undefined,
  overrides: { keys?: JWTVerifyGetKey; nowSeconds?: number } = {}
): Promise<CallerIdentity> {
  return createCallerIdentityVerifier({
    audience: AUDIENCE,
    keys: overrides.keys ?? keys,
    maxTokenAgeSeconds: MAX_TOKEN_AGE_SECONDS,
    now: () => (overrides.nowSeconds ?? ISSUED_AT + 60) * 1000,
  })(header);
}

async function assertRefused(
  result: Promise<CallerIdentity>,
  code: CallerIdentityErrorCode
): Promise<void> {
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof CallerIdentityError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("createCallerIdentityVerifier", () => {
  it("returns the verified email and the token's issue time for a valid Google identity token", async () => {
    assert.deepEqual(await verify(`Bearer ${await signToken()}`), {
      email: EMAIL,
      issuedAt: 1_800_000_000,
    });
  });

  it("reports missing_token for an absent, empty or non-Bearer header", async () => {
    const token = await signToken();
    for (const header of [undefined, "", `Basic ${token}`, token]) {
      await assertRefused(verify(header), "missing_token");
    }
  });

  it("reports invalid_token for a malformed token or one with the wrong audience, issuer, expiry or signature", async () => {
    const tokens = [
      "not-a-jwt",
      await signToken({ audience: "https://another-callee.mock.invalid" }),
      await signToken({ issuer: "https://issuer.mock.invalid" }),
      await signToken({ expiresAt: ISSUED_AT + 30 }),
      await signToken({ key: otherSigningKey }),
    ];
    for (const token of tokens) {
      await assertRefused(verify(`Bearer ${token}`), "invalid_token");
    }
  });

  it("reports invalid_token unless the token carries an email marked verified", async () => {
    const claimSets: JWTPayload[] = [
      { email: EMAIL, email_verified: false },
      { email: EMAIL },
      { email_verified: true },
    ];
    for (const claims of claimSets) {
      await assertRefused(verify(`Bearer ${await signToken({ claims })}`), "invalid_token");
    }
  });

  it("accepts a token up to the maximum age and refuses an older one by the injected clock", async () => {
    const header = `Bearer ${await signToken()}`;
    assert.equal((await verify(header, { nowSeconds: 1_800_000_300 })).email, EMAIL);
    await assertRefused(verify(header, { nowSeconds: 1_800_000_301 }), "invalid_token");
  });

  it("reports invalid_token for a token with no issue time", async () => {
    await assertRefused(verify(`Bearer ${await signToken({ issuedAt: null })}`), "invalid_token");
  });

  it("reports keys_unavailable when the key set cannot produce keys", async () => {
    const header = `Bearer ${await signToken()}`;
    for (const failure of [new TypeError("fetch failed"), new errors.JWKSTimeout()]) {
      await assertRefused(
        verify(header, { keys: () => Promise.reject(failure) }),
        "keys_unavailable"
      );
    }
  });

  it("reports invalid_token when the token names a key the set does not hold", async () => {
    await assertRefused(verify(`Bearer ${await signToken({ kid: "retired" })}`), "invalid_token");
  });

  it("keeps the token and the caller's email out of the error and its cause", async () => {
    const refusals = [
      { token: await signToken({ audience: "https://another-callee.mock.invalid" }) },
      { token: await signToken({ claims: { email: EMAIL, email_verified: false } }) },
      { token: await signToken(), keys: () => Promise.reject(new TypeError("fetch failed")) },
    ];
    for (const { token, keys: failingKeys } of refusals) {
      await assert.rejects(verify(`Bearer ${token}`, { keys: failingKeys }), (error: unknown) => {
        assert.ok(error instanceof CallerIdentityError);
        const rendered = `${String(error)} ${error.stack}`;
        assert.ok(!rendered.includes(token));
        assert.ok(!rendered.includes(EMAIL));
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });
});
