/**
 * Auth context helpers for type-safe auth access in routes
 *
 * These helpers provide type-safe access to auth context set by middleware,
 * avoiding non-null assertions while adding defensive runtime checks.
 */

import type {
  AllowedOperation,
  ApiKeyWalletAuthorizationBinding,
  ApiKeyWalletScope,
  Permission,
  WalletOperationHumanActorType,
} from "@sdp/types";
import type { Context } from "hono";
import type { Env } from "@/types/env";
import { AppError, badRequest } from "./errors";

export type AuthType = "api_key" | "clerk" | "approved_operation";

interface AuthContextBase {
  id: string;
  organizationId: string;
  projectId: string | null;
  role: string;
  permissions: Permission[];
  environment: string;
  /** Operation families/types the key may perform; null or [] is unrestricted. Always null for non-key actors. */
  allowedOperations?: AllowedOperation[] | null;
  walletScope?: ApiKeyWalletScope | null;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: ApiKeyWalletAuthorizationBinding[];
}

/**
 * Normalized auth context returned by getAuth(), discriminated on authType:
 * API key requests always carry apiKeyId; Clerk requests and approved-operation
 * replays always carry userId.
 */
export type ApiKeyContext = AuthContextBase &
  (
    | { authType: "api_key"; apiKeyId: string; userId: null }
    | { authType: "clerk"; apiKeyId: null; userId: string }
    | {
        authType: "approved_operation";
        apiKeyId: null;
        userId: string;
        storedActorType: WalletOperationHumanActorType;
      }
  );

export interface ClerkAuthContext {
  userId: string;
  organizationId: string;
  role: string;
  permissions: Permission[];
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
      role: apiKey.role,
      permissions: apiKey.permissions,
      environment: apiKey.environment,
      allowedOperations: apiKey.allowedOperations ?? null,
      walletScope:
        apiKey.walletScope ??
        ((apiKey.walletBindings?.length ?? 0) > 0 || apiKey.signingWalletId ? "selected" : "all"),
      signingWalletId: apiKey.signingWalletId ?? null,
      signingWalletIds: apiKey.signingWalletIds ?? [],
      walletBindings: apiKey.walletBindings ?? [],
      authType: "api_key",
      userId: null,
      apiKeyId: apiKey.id,
    };
  }

  const projectId = c.get("projectId") ?? null;

  const clerk = c.get("clerk");
  if (clerk) {
    return {
      id: clerk.userId,
      organizationId: clerk.organizationId,
      projectId,
      role: clerk.role,
      permissions: clerk.permissions,
      environment: c.get("projectEnvironment") ?? "dashboard",
      allowedOperations: null,
      walletScope: null,
      signingWalletId: null,
      signingWalletIds: [],
      walletBindings: [],
      authType: "clerk",
      userId: clerk.userId,
      apiKeyId: null,
    };
  }

  const replayActor = c.get("approvedOperationActor");
  if (replayActor) {
    return {
      id: replayActor.userId,
      organizationId: replayActor.organizationId,
      projectId,
      role: "approved_operation",
      permissions: replayActor.permissions,
      environment: c.get("projectEnvironment") ?? "dashboard",
      allowedOperations: null,
      walletScope: null,
      signingWalletId: null,
      signingWalletIds: [],
      walletBindings: [],
      authType: "approved_operation",
      userId: replayActor.userId,
      storedActorType: replayActor.storedActorType,
      apiKeyId: null,
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
 * Whether a dashboard identity may manage organization-wide credentials.
 *
 * Clerk contexts carry both the normalized organization role and its derived
 * permissions; accepting either admin representation keeps capability hints
 * aligned with the authenticated membership. API keys and approved-operation
 * replays are deliberately excluded from credential-administration surfaces.
 */
export function canManageOrganizationCredentials(auth: ApiKeyContext): boolean {
  if (auth.authType !== "clerk") return false;
  return (
    auth.role === "admin" ||
    auth.permissions.includes("org:admin") ||
    auth.permissions.includes("*")
  );
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
    permissions: auth.permissions,
    clerkUserId: auth.clerkUserId,
    clerkOrgId: auth.clerkOrgId,
    email: auth.email ?? null,
    orgSlug: auth.orgSlug ?? null,
    orgRole: auth.orgRole ?? null,
  };
}
