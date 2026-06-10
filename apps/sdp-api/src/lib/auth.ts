/**
 * Auth context helpers for type-safe auth access in routes
 *
 * These helpers provide type-safe access to auth context set by middleware,
 * avoiding non-null assertions while adding defensive runtime checks.
 */

import type { ApiKeyWalletBinding, Permission } from "@sdp/types";
import type { Context } from "hono";
import type { Env } from "@/types/env";
import { AppError, badRequest } from "./errors";

export type AuthType = "api_key" | "clerk" | "session";

/**
 * Normalized auth context returned by getAuth().
 * Supports API key, Clerk JWT, and session-authenticated requests.
 */
export interface ApiKeyContext {
  id: string;
  organizationId: string;
  projectId: string | null;
  role: string;
  permissions: Permission[];
  environment: string;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: ApiKeyWalletBinding[];
  authType: AuthType;
  userId: string | null;
  apiKeyId: string | null;
}

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
 * Get authenticated API key context from request.
 * Use this in protected routes instead of c.get("apiKey")!
 *
 * This provides:
 * 1. Type safety without non-null assertions
 * 2. A defensive runtime check (should never fail in protected routes)
 * 3. Clear error if auth middleware wasn't applied
 *
 * @throws AppError with UNAUTHORIZED if auth is not present
 * @example
 * ```ts
 * const auth = getAuth(c);
 * const orgId = auth.organizationId; // No ! needed
 * ```
 */
export function getAuth(c: Context<{ Bindings: Env }>): ApiKeyContext {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return {
      id: apiKey.id,
      organizationId: apiKey.organizationId,
      projectId: apiKey.projectId,
      role: apiKey.role,
      permissions: apiKey.permissions,
      environment: apiKey.environment,
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
      environment: "dashboard",
      signingWalletId: null,
      signingWalletIds: [],
      walletBindings: [],
      authType: "clerk",
      userId: clerk.userId,
      apiKeyId: null,
    };
  }

  const session = c.get("session");
  if (session) {
    return {
      id: session.userId,
      organizationId: session.organizationId,
      projectId,
      role: "session",
      permissions: session.permissions,
      environment: "dashboard",
      signingWalletId: null,
      signingWalletIds: [],
      walletBindings: [],
      authType: "session",
      userId: session.userId,
      apiKeyId: null,
    };
  }

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
