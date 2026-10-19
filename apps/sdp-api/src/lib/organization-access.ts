import type { Action } from "@sdp/types/actions";
import {
  API_KEY_WALLET_SCOPES,
  type ApiKeyEnvironment,
  type RateLimitTier,
} from "@sdp/types/api-keys";
import { organizationStatusMayAuthenticate } from "@sdp/types/organizations";
import { projectStatusMayAuthenticate } from "@sdp/types/projects";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db/client";
import { parseOptionalPostgresJson, parsePostgresJson } from "@/db/postgres-utils";
import { refuseTerminally } from "@/lib/api-key-refusal-cache";
import { type ApiKeyLifecycleColumns, apiKeyRowRefusal } from "@/lib/api-key-rotation";
import type { WalletAccess } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import { parseGrantsColumn } from "@/services/api-key.service";
import type { Env } from "@/types/env";

/**
 * The one uncached organization read every authenticated request makes, and
 * what it decides (HOO-1955; APE-387, APE-564):
 *
 * - the organization is still `active` — a deleted or suspended organization
 *   stops authenticating on its next request, whatever a cache still says;
 * - for an API key, the key's own row, read in the same statement by key hash:
 *   it is still usable (active, not expired, not past its rotation deadline),
 *   its project is active, and every authorization field (grants, IP
 *   restriction, rate-limit tier, project, environment)
 *   comes from it;
 * - for an API key, its wallet scope and the custody wallets a selected key
 *   lists (HOO-2099), which wallet list and detail reads filter by; signing
 *   re-checks the list itself, at the waist;
 * - for an API key, the request's origin passes `settings.allowedIpAddresses`.
 *
 * Deliberately uncached: a cache would keep the previous answer for its TTL
 * after a revocation, a grant change or an allowlist change.
 *
 * Returns the raw settings it read, so authentication records the
 * organization's entitlements from the same read (APE-351).
 */

/**
 * Returned as `unknown` on purpose: pre-validation values can be any shape,
 * and {@link isClientIpAllowed} already fails closed on anything unrecognized —
 * that decision belongs in one place.
 */
function readAllowedIpAddresses(settings: string | null): unknown {
  if (!settings) {
    return null;
  }

  const parsed = parsePostgresJson<{ allowedIpAddresses?: unknown } | null>(settings);
  return parsed?.allowedIpAddresses ?? null;
}

/**
 * Apply `settings.allowedIpAddresses` to an API-key request. The allowlist
 * restricts where the organization's keys may be used from; it never filters
 * a signed-in member, whose dashboard requests reach the API from SDP's own
 * servers. A key's own `allowedIps` intersects on top.
 *
 * A malformed restriction fails closed. The settings column is JSON the API
 * writes itself, so a blob that does not parse is a bug: it throws, and the
 * request fails loudly with a 500.
 */
function enforceIpAllowlist(c: Context<{ Bindings: Env }>, settings: string | null): void {
  if (!isClientIpAllowed(getClientIp(c), readAllowedIpAddresses(settings))) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed for this organization");
  }
}

/** The refusal a session-based door (Clerk) gives a non-active organization. */
export function organizationNotActive(): AppError {
  return new AppError("UNAUTHORIZED", "Organization is not active");
}

/**
 * The session doors' uncached organization read: the organization must exist
 * and be `active`. Returns its raw settings.
 */
export async function readActiveOrganizationSettings(
  env: Env,
  organizationId: string
): Promise<string | null> {
  const row = await getDb(env)
    .prepare("SELECT status, settings FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ status: string; settings: string | null }>();

  if (!row || !organizationStatusMayAuthenticate(row.status)) {
    throw organizationNotActive();
  }
  return row.settings;
}

/** The key's active `api_key_signing_wallets`, aggregated to a `text[]`. */
const signingWalletIdsSchema = z.array(z.string());

const walletScopeSchema = z.enum(API_KEY_WALLET_SCOPES);

/** The `api_keys` row and its joins, as the authoritative read returns them. */
type ApiKeyAuthorizationRow = ApiKeyLifecycleColumns & {
  id: string;
  organization_id: string;
  project_id: string;
  grants: unknown;
  grants_assigned: boolean;
  allowed_ips: string | null;
  rate_limit_tier: RateLimitTier;
  wallet_scope: string;
  signing_wallet_ids: unknown;
  environment: ApiKeyEnvironment;
  project_status: string;
  organization_status: string;
  settings: string | null;
};

/** Everything an API key may do on this request, all from one read. */
export interface ApiKeyAuthorization {
  id: string;
  organizationId: string;
  projectId: string;
  /** The key's explicit grants: aliases expanded, unknown strings dropped. */
  grants: Action[];
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  /** The organization's raw settings, for its entitlements. */
  settings: string | null;
  walletAccess: WalletAccess;
}

/**
 * Authorize an API key from its live rows: one uncached statement driven by
 * `api_keys.key_hash` (UNIQUE) that returns the key's every authorization
 * field, its project's status and environment, its organization's status and
 * settings, and its wallet scope with the custody wallet ids a selected key
 * lists. Nothing is cached, so a revocation, a grant change, an IP
 * restriction, an archived project or a narrowed wallet scope applies on the
 * key's next request.
 *
 * Refuses, in order: an unknown key (INVALID_API_KEY); an inactive
 * organization or project (REVOKED_API_KEY); a revoked, expired or
 * past-its-rotation-deadline key (REVOKED_API_KEY / EXPIRED_API_KEY); a key
 * that predates grants (REVOKED_API_KEY); an
 * origin outside the key's `allowed_ips`, then the organization's allowlist
 * (FORBIDDEN). The filters stay out of SQL so each refusal keeps its code.
 */
export async function authorizeApiKey(
  c: Context<{ Bindings: Env }>,
  keyHash: string
): Promise<ApiKeyAuthorization> {
  const row = await getDb(c.env)
    .prepare(
      `SELECT ak.id, ak.organization_id, ak.project_id, ak.grants, ak.grants_assigned,
              ak.allowed_ips, ak.rate_limit_tier,
              ak.status, ak.expires_at, ak.rotation_deadline, ak.wallet_scope,
              ARRAY(
                SELECT s.custody_wallet_id
                  FROM api_key_signing_wallets s
                 WHERE s.api_key_id = ak.id AND s.status = 'active'
                 ORDER BY s.custody_wallet_id
              ) AS signing_wallet_ids,
              p.environment, p.status AS project_status,
              o.status AS organization_status, o.settings
         FROM api_keys ak
         JOIN organizations o ON o.id = ak.organization_id
         JOIN projects p ON p.id = ak.project_id AND p.organization_id = ak.organization_id
        WHERE ak.key_hash = ?`
    )
    .bind(keyHash)
    .first<ApiKeyAuthorizationRow>();

  if (!row) {
    throw refuseTerminally(keyHash, "INVALID_API_KEY");
  }
  // Organization and project status before the key's own: a key created or
  // rotated after an organization deletion enumerated its keys is covered by
  // neither that deletion's revocation nor anything else.
  if (
    !organizationStatusMayAuthenticate(row.organization_status) ||
    !projectStatusMayAuthenticate(row.project_status)
  ) {
    throw new AppError("REVOKED_API_KEY");
  }
  const refusal = apiKeyRowRefusal(row, Date.now());
  // A dead key never comes back, so its refusal is remembered; the
  // organization and project refusals above can lift and are not.
  if (refusal === "revoked") {
    throw refuseTerminally(keyHash, "REVOKED_API_KEY");
  }
  if (refusal === "expired") {
    throw refuseTerminally(keyHash, "EXPIRED_API_KEY");
  }
  // A key from before grants holds none until a person gives it some; it is
  // refused by name rather than failing every route. Not remembered: setting
  // its grants makes it usable on the next request.
  if (!row.grants_assigned) {
    throw new AppError(
      "REVOKED_API_KEY",
      "This API key predates action grants. Give it grants on the API keys page, or create a new key."
    );
  }
  if (!isClientIpAllowed(getClientIp(c), parseOptionalPostgresJson<unknown>(row.allowed_ips))) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed for this API key");
  }
  enforceIpAllowlist(c, row.settings);

  const custodyWalletIds = signingWalletIdsSchema.parse(row.signing_wallet_ids);
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    grants: parseGrantsColumn(row.grants),
    environment: row.environment,
    rateLimitTier: row.rate_limit_tier,
    settings: row.settings,
    walletAccess:
      walletScopeSchema.parse(row.wallet_scope) === "all"
        ? { scope: "all" }
        : { scope: "selected", custodyWalletIds },
  };
}
