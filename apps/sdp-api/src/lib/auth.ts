/**
 * Auth context helpers for type-safe auth access in routes
 *
 * These helpers provide type-safe access to auth context set by middleware,
 * avoiding non-null assertions while adding defensive runtime checks.
 */

import type { Env } from "@/types/env";
import type { Permission } from "@sdp/types";
import type { Context } from "hono";
import { AppError } from "./errors";

/**
 * Strongly-typed API key context returned by getAuth()
 */
export interface ApiKeyContext {
  id: string;
  organizationId: string;
  projectId: string | null;
  role: string;
  permissions: Permission[];
  environment: string;
  signingWalletId: string | null;
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
  const auth = c.get("apiKey");
  if (!auth) {
    throw new AppError("UNAUTHORIZED", "Authentication required");
  }
  return {
    id: auth.id,
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    role: auth.role,
    permissions: auth.permissions,
    environment: auth.environment,
    signingWalletId: auth.signingWalletId ?? null,
  };
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
