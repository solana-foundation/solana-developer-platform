import type { Context } from "hono";
import { getAuth } from "@/lib/auth";
import type { Env } from "@/types/env";

declare const tenantScopeBrand: unique symbol;

/**
 * Trusted tenant identity established by authentication and project-context
 * middleware. `projectId` remains explicitly nullable for organization-level
 * resources; callers may not omit it.
 */
export interface TenantScope {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly [tenantScopeBrand]: true;
}

export class TenantScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeViolationError";
  }
}

export function createTenantScope(input: {
  organizationId: string;
  projectId: string | null;
}): TenantScope {
  const organizationId = input.organizationId.trim();
  const projectId = input.projectId?.trim() ?? null;

  if (!organizationId) {
    throw new TenantScopeViolationError("Tenant organizationId is required");
  }
  if (input.projectId !== null && !projectId) {
    throw new TenantScopeViolationError("Tenant projectId cannot be empty");
  }

  return Object.freeze({
    organizationId,
    projectId,
  }) as TenantScope;
}

/**
 * Derive scope only from authenticated middleware state. Request headers,
 * query parameters, and bodies are deliberately not consulted.
 */
export function getRequestTenantScope(c: Context<{ Bindings: Env }>): TenantScope {
  const auth = getAuth(c);
  return createTenantScope({
    organizationId: auth.organizationId,
    projectId: c.get("projectId") ?? auth.projectId ?? null,
  });
}

export function assertTenantClaim(
  scope: TenantScope,
  claim: { organizationId: unknown; projectId: unknown },
  operation: string
): void {
  if (claim.organizationId !== scope.organizationId) {
    throw new TenantScopeViolationError(
      `${operation} cannot override the repository organization scope`
    );
  }

  if (claim.projectId !== scope.projectId) {
    throw new TenantScopeViolationError(
      `${operation} cannot override the repository project scope`
    );
  }
}

function assertNestedTenantClaims(
  scope: TenantScope,
  value: unknown,
  operation: string,
  visited: WeakSet<object>
): void {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }

  visited.add(value);
  if (value instanceof Map) {
    for (const [key, nested] of value) {
      assertNestedTenantClaims(scope, key, operation, visited);
      assertNestedTenantClaims(scope, nested, operation, visited);
    }
    return;
  }

  if (value instanceof Set) {
    for (const nested of value) {
      assertNestedTenantClaims(scope, nested, operation, visited);
    }
    return;
  }

  if (!Array.isArray(value)) {
    const record = value as Record<PropertyKey, unknown>;
    if ("organizationId" in record && record.organizationId !== scope.organizationId) {
      throw new TenantScopeViolationError(
        `${operation} cannot override the repository organization scope`
      );
    }
    if ("projectId" in record && record.projectId !== scope.projectId) {
      throw new TenantScopeViolationError(
        `${operation} cannot override the repository project scope`
      );
    }
    if ("organization_id" in record && record.organization_id !== scope.organizationId) {
      throw new TenantScopeViolationError(
        `${operation} cannot override the repository organization scope`
      );
    }
    if ("project_id" in record && record.project_id !== scope.projectId) {
      throw new TenantScopeViolationError(
        `${operation} cannot override the repository project scope`
      );
    }
  }

  for (const nested of Object.values(value)) {
    assertNestedTenantClaims(scope, nested, operation, visited);
  }
}

export function bindRepositoryToTenant<T extends object>(
  repository: T,
  scope: TenantScope,
  repositoryName: string,
  systemOnlyMethods: readonly string[] = []
): T {
  const denied = new Set(systemOnlyMethods);

  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => {
        const method = String(property);
        if (denied.has(method)) {
          throw new TenantScopeViolationError(
            `${repositoryName}.${method} is system-only and unavailable to tenant callers`
          );
        }

        for (const argument of args) {
          assertNestedTenantClaims(scope, argument, `${repositoryName}.${method}`, new WeakSet());
        }

        return Reflect.apply(value, target, args);
      };
    },
  });
}
