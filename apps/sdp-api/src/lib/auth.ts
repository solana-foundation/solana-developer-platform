/**
 * Auth context helpers for type-safe auth access in routes
 *
 * These helpers provide type-safe access to auth context set by middleware,
 * avoiding non-null assertions while adding defensive runtime checks.
 */

import { type Action, apiKeyMayPerform, organizationRoleMayPerform } from "@sdp/types/actions";
import type { OrganizationRole } from "@sdp/types/roles";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "@/types/env";
import { AppError, badRequest } from "./errors";

export type AuthType = "api_key" | "clerk";

/**
 * Which custody wallets the caller may sign with and list (HOO-2099): every
 * wallet in the project, or the exact custody wallet ids a selected API key
 * lists. Signing enforces it at the custody signer; only the wallet list and
 * wallet detail reads filter by it. Every other read is project-scoped.
 */
export const walletAccessSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }),
  z.object({ scope: z.literal("selected"), custodyWalletIds: z.array(z.string()).readonly() }),
]);

export type WalletAccess = Readonly<z.infer<typeof walletAccessSchema>>;

interface AuthContextBase {
  id: string;
  organizationId: string;
  projectId: string | null;
  environment: string;
  walletAccess: WalletAccess;
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

const ALL_WALLETS: WalletAccess = Object.freeze({ scope: "all" });

/** Whether the caller may list or open this custody wallet (`GET /v1/wallets`, `/:walletId`). */
export function walletAccessAllows(access: WalletAccess, custodyWalletId: string): boolean {
  return access.scope === "all" || access.custodyWalletIds.includes(custodyWalletId);
}

export interface ClerkAuthContext {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  clerkUserId: string;
  clerkOrgId: string;
  email: string | null;
  orgSlug: string | null;
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
      walletAccess: apiKey.walletAccess,
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
      walletAccess: ALL_WALLETS,
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
  };
}
