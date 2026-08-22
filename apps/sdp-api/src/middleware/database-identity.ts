/**
 * Ambient database identity for HTTP requests.
 *
 * Authenticated routes get their tenant identity from the auth middlewares;
 * this middleware handles everything before/without authentication:
 *
 *  - A small registry of public surfaces that legitimately reach the database
 *    without a tenant (provider webhooks, the public payment page, the
 *    pre-auth login/session flows, credential-gated admin routes) runs under
 *    a named system identity.
 *  - Every other path is explicitly marked identity-less, so any database
 *    access that happens before an auth middleware narrows the request is
 *    denied by row-level security (migration 0067) instead of silently
 *    reading across tenants.
 *
 * Adding a prefix here grants cross-tenant database access to an
 * unauthenticated surface — treat changes like tenant-boundary changes
 * (src/lib/tenant-boundary.test.ts guards the registry).
 */

import type { Context, Next } from "hono";
import { runWithoutDatabaseIdentity, runWithSystemDatabaseIdentity } from "@/db";
import type { Env } from "@/types/env";

export const PUBLIC_SYSTEM_PATH_PREFIXES: ReadonlyArray<{
  readonly prefix: string;
  readonly component: string;
}> = [
  // Provider webhooks authenticate by signature and carry only provider
  // references; tenant resolution happens against provider lookup columns.
  { prefix: "/webhooks", component: "http:webhooks" },
  // Public payment page: resolves payment requests by public token.
  { prefix: "/pay", component: "http:pay" },
  // Login/magic-link/session issuance runs before any session exists.
  { prefix: "/v1/auth", component: "http:auth-routes" },
];

function matchPublicComponent(path: string): string | null {
  for (const entry of PUBLIC_SYSTEM_PATH_PREFIXES) {
    if (path === entry.prefix || path.startsWith(`${entry.prefix}/`)) {
      return entry.component;
    }
  }
  return null;
}

export function databaseIdentityBoundary() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const component = matchPublicComponent(c.req.path);
    if (component) {
      return runWithSystemDatabaseIdentity(component, next);
    }
    return runWithoutDatabaseIdentity("http:pre-auth", next);
  };
}
