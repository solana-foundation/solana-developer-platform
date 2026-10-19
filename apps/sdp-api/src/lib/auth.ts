/**
 * Auth context helpers for type-safe auth access in routes
 *
 * These helpers provide type-safe access to auth context set by middleware,
 * avoiding non-null assertions while adding defensive runtime checks.
 */

import { type Action, apiKeyMayPerform, organizationRoleMayPerform } from "@sdp/types/actions";
import type { ApiKeyWalletAuthorizationBinding, ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { OrganizationRole } from "@sdp/types/permissions";
import type { Context } from "hono";
import type { Env } from "@/types/env";
import { AppError, badRequest } from "./errors";

export type AuthType = "api_key" | "clerk";

interface AuthContextBase {
  id: string;
  organizationId: string;
  projectId: string | null;
  environment: string;
  walletScope?: ApiKeyWalletScope | null;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: ApiKeyWalletAuthorizationBinding[];
}

/**
 * Normalized auth context returned by getAuth(), discriminated on authType:
 * API key requests always carry apiKeyId and the key's grants; Clerk requests
 * always carry userId and the member's organization role.
 */
export type ApiKeyContext = AuthContextBase &
  (
    | {
        authType: "api_key";
        apiKeyId: string;
        userId: null;
        grants: readonly Action[];
        role: null;
      }
    | {
        authType: "clerk";
        apiKeyId: null;
        userId: string;
        grants: null;
        role: OrganizationRole;
      }
  );

/**
 * Whether this caller may perform the action: an API key by its grants (never
 * an action no key may hold), a member by their organization role.
 */
export function authMayPerform(auth: ApiKeyContext, action: Action): boolean {
  switch (auth.authType) {
    case "api_key":
      return apiKeyMayPerform(auth.grants, action);
    case "clerk":
      return organizationRoleMayPerform(auth.role, action);
    default: {
      const exhaustive: never = auth;
      throw new Error(`Unknown auth type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface ClerkAuthContext {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  clerkUserId: string;
  clerkOrgId: string;
  email: string | null;
  orgSlug: string | null;
  orgRole: string | null;
}

/**
 * Get the normalized auth context when the request authenticated through any
 * supported mode. Optional routes use this to preserve keyed behavior without
 * manufacturing an identity for anonymous callers.
 *
 * This provides:
 * 1. Type safety without non-null assertions
 * 2. A defensive runtime check (should never fail in protected routes)
 * 3. Clear error if auth middleware wasn't applied
 *
 */
export function getOptionalAuth(c: Context<{ Bindings: Env }>): ApiKeyContext | null {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return {
      id: apiKey.id,
      organizationId: apiKey.organizationId,
      projectId: apiKey.projectId,
      environment: apiKey.environment,
      walletScope:
        apiKey.walletScope ??
        ((apiKey.walletBindings?.length ?? 0) > 0 || apiKey.signingWalletId ? "selected" : "all"),
      signingWalletId: apiKey.signingWalletId ?? null,
      signingWalletIds: apiKey.signingWalletIds ?? [],
      walletBindings: apiKey.walletBindings ?? [],
      authType: "api_key",
      userId: null,
      apiKeyId: apiKey.id,
      grants: apiKey.grants,
      role: null,
    };
  }

  const projectId = c.get("projectId") ?? null;

  const clerk = c.get("clerk");
  if (clerk) {
    return {
      id: clerk.userId,
      organizationId: clerk.organizationId,
      projectId,
      environment: c.get("projectEnvironment") ?? "dashboard",
      walletScope: null,
      signingWalletId: null,
      signingWalletIds: [],
      walletBindings: [],
      authType: "clerk",
      userId: clerk.userId,
      apiKeyId: null,
      grants: null,
      role: clerk.role,
    };
  }

  return null;
}

/**
 * Require the normalized auth context. Protected routes use this instead of
 * non-null assertions so a missing middleware remains a typed 401.
 */
export function getAuth(c: Context<{ Bindings: Env }>): ApiKeyContext {
  const auth = getOptionalAuth(c);
  if (auth) return auth;
  throw new AppError("UNAUTHORIZED", "Authentication required");
}

/**
 * Get the resolved project ID from request context.
 * The projectContextMiddleware guarantees this is set for any route it gates;
 * the runtime check here is defense-in-depth for handlers that may be reused
 * outside that middleware.
 *
 * @throws AppError BAD_REQUEST if no project scope is available.
 */
export function requireProjectId(c: Context<{ Bindings: Env }>): string {
  const projectId = c.get("projectId");
  if (!projectId) {
    throw badRequest("Project scope is required");
  }
  return projectId;
}

/**
 * Get the project ID from an already-resolved auth context. For helpers that
 * hold only `auth` (no request context) on a project-scoped route; the
 * projectContextMiddleware has already rejected requests without one.
 *
 * @param auth - The normalized auth context for the request.
 * @returns The project the request is scoped to.
 * @throws AppError BAD_REQUEST if the auth context carries no project scope.
 */
export function requireAuthProjectId(auth: ApiKeyContext): string {
  if (!auth.projectId) {
    throw badRequest("Project scope is required");
  }
  return auth.projectId;
}

/**
 * Whether a dashboard identity may manage organization-wide credentials: an
 * organization administrator, the only role that holds `organizations.manage`.
 * API keys are deliberately excluded from credential-administration surfaces.
 */
export function canManageOrganizationCredentials(auth: ApiKeyContext): boolean {
  return auth.authType === "clerk" && authMayPerform(auth, "organizations.manage");
}

export function getClerkAuth(c: Context<{ Bindings: Env }>): ClerkAuthContext {
  const auth = c.get("clerk");
  if (!auth) {
    throw new AppError("UNAUTHORIZED", "Clerk authentication required");
  }
  return {
    userId: auth.userId,
    organizationId: auth.organizationId,
    role: auth.role,
    clerkUserId: auth.clerkUserId,
    clerkOrgId: auth.clerkOrgId,
    email: auth.email ?? null,
    orgSlug: auth.orgSlug ?? null,
    orgRole: auth.orgRole ?? null,
  };
}
