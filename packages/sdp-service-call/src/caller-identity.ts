import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const BEARER_TOKEN = /^Bearer (\S+)$/i;

export const CALLER_IDENTITY_ERROR_CODES = [
  "missing_token",
  "invalid_token",
  "keys_unavailable",
] as const;
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

class KeysUnavailable extends Error {}

const verifiedCallerClaims = z.object({
  email: z.string().min(1),
  email_verified: z.literal(true),
  iat: z.number(),
});

export interface CallerIdentity {
  email: string;
  // The token's `iat`, in seconds since the epoch.
  issuedAt: number;
}

export function createGoogleIdentityKeys(): ReturnType<typeof createRemoteJWKSet> {
  return createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
}

export function createCallerIdentityVerifier(options: {
  audience: string;
  keys: JWTVerifyGetKey;
  maxTokenAgeSeconds: number;
  now: () => number;
}): (authorizationHeader: string | undefined) => Promise<CallerIdentity> {
  // A token that names a key the set does not hold is the token's fault. Any other failure to
  // produce a key is the key set's, and is reported apart from a bad token.
  const keys: JWTVerifyGetKey = async (protectedHeader, token) => {
    try {
      return await options.keys(protectedHeader, token);
    } catch (error) {
      if (
        error instanceof errors.JWKSNoMatchingKey ||
        error instanceof errors.JWKSMultipleMatchingKeys
      ) {
        throw error;
      }
      throw new KeysUnavailable();
    }
  };

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
        maxTokenAge: options.maxTokenAgeSeconds,
        currentDate: new Date(options.now()),
      }));
    } catch (error) {
      if (error instanceof KeysUnavailable) {
        throw new CallerIdentityError("Identity keys could not be read", "keys_unavailable");
      }
      throw new CallerIdentityError("Caller identity token failed verification", "invalid_token");
    }

    const claims = verifiedCallerClaims.safeParse(payload);
    if (!claims.success) {
      throw new CallerIdentityError("Caller identity token has no verified email", "invalid_token");
    }
    return { email: claims.data.email, issuedAt: claims.data.iat };
  };
}
