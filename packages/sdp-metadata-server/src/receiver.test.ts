import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  createLocalJWKSet,
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
} from "./receiver";

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
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(trusted.publicKey)), alg: "RS256" }] });
});

function signToken(
  options: {
    claims?: JWTPayload;
    audience?: string;
    issuer?: string;
    expiresAt?: number;
    key?: CryptoKey;
  } = {}
): Promise<string> {
  return new SignJWT(options.claims ?? { email: EMAIL, email_verified: true })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(ISSUED_AT)
    .setExpirationTime(options.expiresAt ?? ISSUED_AT + 3600)
    .sign(options.key ?? signingKey);
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

  it("refuses a token older than the maximum age plus the clock tolerance", async () => {
    const header = `Bearer ${await signToken()}`;
    assert.equal((await verify(header, { nowSeconds: 1_800_000_305 })).email, EMAIL);
    await assertRefused(verify(header, { nowSeconds: 1_800_000_306 }), "invalid_token");
  });

  it("accepts a token issued ahead of the clock only within the tolerance", async () => {
    const header = `Bearer ${await signToken()}`;
    assert.equal((await verify(header, { nowSeconds: 1_799_999_995 })).email, EMAIL);
    await assertRefused(verify(header, { nowSeconds: 1_799_999_994 }), "invalid_token");
  });

  it("reports keys_unavailable, not invalid_token, when the key set cannot be read", async () => {
    const failing = () => Promise.reject(new TypeError("fetch failed"));
    await assertRefused(
      verify(`Bearer ${await signToken()}`, { keys: failing }),
      "keys_unavailable"
    );
  });

  it("keeps the token and the caller's email out of the error and its cause", async () => {
    const tokens = [
      await signToken({ audience: "https://another-callee.mock.invalid" }),
      await signToken({ claims: { email: EMAIL, email_verified: false } }),
    ];
    for (const token of tokens) {
      await assert.rejects(verify(`Bearer ${token}`), (error: unknown) => {
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
