import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  generateSecret,
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
  UnsecuredJWT,
} from "jose";
import {
  CallerIdentityError,
  type CallerIdentityErrorCode,
  createCallerIdentityVerifier,
} from "./caller-identity";

const AUDIENCE = "https://callee.mock.invalid";
const ISSUER = "https://accounts.google.com";
const EMAIL = "caller@service-account.mock.invalid";

let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let keys: JWTVerifyGetKey;

before(async () => {
  const trusted = await generateKeyPair("RS256");
  const untrusted = await generateKeyPair("RS256");
  signingKey = trusted.privateKey;
  otherSigningKey = untrusted.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(trusted.publicKey)), alg: "RS256" }] });
});

const validClaims: JWTPayload = { email: EMAIL, email_verified: true };

function signToken(
  options: {
    claims?: JWTPayload;
    audience?: string;
    issuer?: string;
    expiresAt?: number | string;
    key?: CryptoKey;
  } = {}
): Promise<string> {
  return new SignJWT(options.claims ?? validClaims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? "10m")
    .sign(options.key ?? signingKey);
}

function verify(header: string | undefined): Promise<{ email: string }> {
  return createCallerIdentityVerifier({ audience: AUDIENCE, keys })(header);
}

async function assertRejectsWith(
  header: string | undefined,
  code: CallerIdentityErrorCode
): Promise<void> {
  await assert.rejects(verify(header), (error: unknown) => {
    assert.ok(error instanceof CallerIdentityError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("createCallerIdentityVerifier", () => {
  it("returns exactly the verified email for a valid Google identity token", async () => {
    assert.deepEqual(await verify(`Bearer ${await signToken()}`), { email: EMAIL });
  });

  it("reports missing_token for an absent, empty or non-Bearer header", async () => {
    const token = await signToken();
    for (const header of [undefined, "", `Basic ${token}`, token]) {
      await assertRejectsWith(header, "missing_token");
    }
  });

  it("reports invalid_token for a token with the wrong audience, issuer, lifetime or key", async () => {
    const tokens = [
      await signToken({ audience: "https://another-callee.mock.invalid" }),
      await signToken({ issuer: "https://issuer.mock.invalid" }),
      await signToken({ expiresAt: Math.floor(Date.now() / 1000) - 60 }),
      await signToken({ key: otherSigningKey }),
    ];
    for (const token of tokens) {
      await assertRejectsWith(`Bearer ${token}`, "invalid_token");
    }
  });

  it("reports invalid_token unless the token carries an email marked verified", async () => {
    const claimSets: JWTPayload[] = [
      { email: EMAIL, email_verified: false },
      { email: EMAIL },
      { email_verified: true },
    ];
    for (const claims of claimSets) {
      await assertRejectsWith(`Bearer ${await signToken({ claims })}`, "invalid_token");
    }
  });

  it("reports invalid_token for an unsigned token, an HS256 token and a malformed token", async () => {
    const unsigned = new UnsecuredJWT(validClaims)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("10m")
      .encode();
    const hmac = await new SignJWT(validClaims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("10m")
      .sign(await generateSecret("HS256"));
    for (const token of [unsigned, hmac, "not-a-jwt"]) {
      await assertRejectsWith(`Bearer ${token}`, "invalid_token");
    }
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
