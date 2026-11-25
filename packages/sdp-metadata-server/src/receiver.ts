import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const BEARER_TOKEN = /^Bearer (\S+)$/i;

export const CALLER_IDENTITY_ERROR_CODES = ["missing_token", "invalid_token"] as const;
export type CallerIdentityErrorCode = (typeof CALLER_IDENTITY_ERROR_CODES)[number];

export class CallerIdentityError extends Error {
  constructor(
    message: string,
    public readonly code: CallerIdentityErrorCode
  ) {
    super(message);
    this.name = "CallerIdentityError";
  }
}

const verifiedCallerClaims = z.object({
  email: z.string().min(1),
  email_verified: z.literal(true),
});

export function createCallerIdentityVerifier(options: {
  audience: string;
  keys?: JWTVerifyGetKey;
}): (authorizationHeader: string | undefined) => Promise<{ email: string }> {
  const keys = options.keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

  return async (authorizationHeader) => {
    const token = authorizationHeader?.match(BEARER_TOKEN)?.[1];
    if (!token) {
      throw new CallerIdentityError("Authorization header has no bearer token", "missing_token");
    }

    // The verification error is not kept as a cause: jose errors can carry the token's claims.
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: GOOGLE_ISSUER,
        audience: options.audience,
        algorithms: ["RS256"],
      }));
    } catch {
      throw new CallerIdentityError("Caller identity token failed verification", "invalid_token");
    }

    const claims = verifiedCallerClaims.safeParse(payload);
    if (!claims.success) {
      throw new CallerIdentityError("Caller identity token has no verified email", "invalid_token");
    }
    return { email: claims.data.email };
  };
}
