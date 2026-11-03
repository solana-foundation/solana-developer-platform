import { isIP } from "node:net";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";
import type { Env } from "@/types/env";

/**
 * The Foundation API gateway's signed caller identity (HOO-2256).
 *
 * The gateway authenticates the caller (an `sf_` key or a Clerk session),
 * then forwards the request with `X-SF-Identity`: an ES256 JWT, valid for 60
 * seconds, signed by the gateway's JWKS. SDP keeps its own authorization
 * (grants, wallet bindings, row-level security); the identity only says who
 * the caller is and where the request came from.
 *
 * Until the gateway fronts every request, both paths are accepted: a request
 * with a verified identity, and a request that presents its key directly. The
 * header is read only when `SF_GATEWAY_ISSUER` and `SF_GATEWAY_JWKS_URL` are
 * set; without them it is caller-chosen and ignored.
 */
export const GATEWAY_IDENTITY_HEADER = "X-SF-Identity";

/** The app the gateway names SDP by; a token minted for another app is refused. */
export const GATEWAY_AUDIENCE = "sdp";

const GATEWAY_MAX_TOKEN_AGE_SECONDS = 60;
const GATEWAY_CLOCK_TOLERANCE_SECONDS = 5;

// The gateway serializes an absent claim as JSON `null` rather than omitting
// it, so every optional claim accepts both. Claims SDP does not read (such as
// `grants`) are ignored.
const claimsSchema = z
  .object({
    project_id: z.string().min(1).nullish(),
    org_id: z.string().min(1).nullish(),
    // An `sf_` key ID only. A legacy `sk_` key the gateway forwards carries its
    // SDP row id here and is refused: `sk_` keys are retired (the prerelease
    // database is wiped) before gateway mode is enabled.
    key_id: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .nullish(),
    clerk_user_id: z.string().min(1).nullish(),
    plan: z.string().min(1).nullish(),
    client_ip: z.string().refine((value) => isIP(value) !== 0, "client_ip must be an IP address"),
    request_id: z.string().min(1).nullish(),
  })
  .refine((claims) => (claims.key_id == null) !== (claims.clerk_user_id == null), {
    message: "exactly one of key_id and clerk_user_id",
  });

export interface GatewayIdentity {
  /** The gateway project: the customer team, one per SDP organization. */
  projectId: string | null;
  /**
   * The organization the gateway authenticated under: a Clerk session's active
   * organization, or (for now) the project for a key. Compared only against a
   * forwarded Clerk session.
   */
  orgId: string | null;
  /** The `sf_` key ID the gateway authenticated, or null for a Clerk session. */
  keyId: string | null;
  /** The Clerk user the gateway authenticated, or null for a key. */
  clerkUserId: string | null;
  plan: string | null;
  /** The client address the gateway saw; replaces any forwarding header. */
  clientIp: string;
  requestId: string | null;
}

export interface GatewayIdentityConfig {
  issuer: string;
  jwksUrl: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const configSchema = z.object({
  issuer: z.string().min(1),
  // The JWKS decides who can mint an identity for any key, so it is fetched
  // over TLS only: plain HTTP lets an on-path attacker swap the signing key.
  // Loopback HTTP is for a local gateway in development.
  jwksUrl: z.url({ protocol: /^https?$/ }).refine((value) => {
    // Refinements run after a failed URL check too; that value is refused there.
    if (!URL.canParse(value)) {
      return false;
    }
    const url = new URL(value);
    return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  }),
});

/**
 * The configured gateway, or null when no gateway fronts this deployment.
 * Parsed at boot (`assertRequiredEnv`), so a malformed value fails startup
 * rather than every signed request.
 *
 * Gateway mode needs a trusted client IP (`TRUST_PROXY_HEADERS`): identities
 * are verified before any request limit, and only a trusted address can bound
 * the verifications a caller forces.
 */
export function resolveGatewayIdentityConfig(
  env: Pick<Env, "SF_GATEWAY_ISSUER" | "SF_GATEWAY_JWKS_URL" | "TRUST_PROXY_HEADERS">
): GatewayIdentityConfig | null {
  const issuer = env.SF_GATEWAY_ISSUER?.trim();
  const jwksUrl = env.SF_GATEWAY_JWKS_URL?.trim();
  if (!issuer && !jwksUrl) {
    return null;
  }
  if (!issuer || !jwksUrl) {
    throw new Error("SF_GATEWAY_ISSUER and SF_GATEWAY_JWKS_URL must be set together");
  }
  const parsed = configSchema.safeParse({ issuer, jwksUrl });
  if (!parsed.success) {
    throw new Error("SF_GATEWAY_JWKS_URL must be an https URL (http only on loopback)");
  }
  if (env.TRUST_PROXY_HEADERS !== "gclb" && env.TRUST_PROXY_HEADERS !== "true") {
    throw new Error("SF_GATEWAY_* requires TRUST_PROXY_HEADERS (gclb or true)");
  }
  return parsed.data;
}

/** The gateway's signing keys could not be fetched; nothing about the token is known. */
export class GatewayKeysUnavailableError extends Error {
  constructor(options: { cause: unknown }) {
    super("Gateway signing keys are unavailable", options);
    this.name = "GatewayKeysUnavailableError";
  }
}

/**
 * How long a fetched JWKS is trusted, and the shortest gap between refetches
 * for an unknown key. A key the gateway removes stops verifying within a
 * minute; a new key must be published at least two minutes before the
 * gateway signs with it. One small fetch a minute per instance at most.
 */
const JWKS_CACHE_MAX_AGE_MS = 60_000;
const JWKS_COOLDOWN_MS = 10_000;

const signingKeysCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getSigningKeys(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  let keys = signingKeysCache.get(jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUrl), {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
    });
    signingKeysCache.set(jwksUrl, keys);
  }
  return keys;
}

/**
 * Verifies an `X-SF-Identity` token: ES256 only, the configured issuer, the
 * `sdp` audience, and at most 60 seconds old.
 *
 * @throws GatewayKeysUnavailableError when the JWKS cannot be fetched; any
 *   other error means the token is not a valid identity.
 */
export async function verifyGatewayIdentity(
  token: string,
  config: GatewayIdentityConfig
): Promise<GatewayIdentity> {
  const keys = getSigningKeys(config.jwksUrl);
  const { payload } = await jwtVerify(
    token,
    async (header, input) => {
      try {
        return await keys(header, input);
      } catch (error) {
        // A failed fetch is not a JOSE error, and an HTTP error from the
        // JWKS endpoint is the generic one; a key the set lacks is specific.
        const unavailable =
          !(error instanceof errors.JOSEError) ||
          error instanceof errors.JWKSTimeout ||
          error instanceof errors.JWKSInvalid ||
          error.code === errors.JOSEError.code;
        throw unavailable ? new GatewayKeysUnavailableError({ cause: error }) : error;
      }
    },
    {
      issuer: config.issuer,
      audience: GATEWAY_AUDIENCE,
      algorithms: ["ES256"],
      maxTokenAge: GATEWAY_MAX_TOKEN_AGE_SECONDS,
      clockTolerance: GATEWAY_CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["iat", "exp"],
    }
  );
  const claims = claimsSchema.parse(payload);
  return {
    projectId: claims.project_id ?? null,
    orgId: claims.org_id ?? null,
    keyId: claims.key_id ?? null,
    clerkUserId: claims.clerk_user_id ?? null,
    plan: claims.plan ?? null,
    clientIp: claims.client_ip,
    requestId: claims.request_id ?? null,
  };
}
