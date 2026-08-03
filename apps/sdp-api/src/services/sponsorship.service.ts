import { createFeePaymentAdapter, type FeePaymentPort } from "@sdp/payments/fee-payment";
import type { ProjectEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import { ProjectService } from "./project.service";

export type SponsorshipActorType = "api_key" | "project" | "user" | "wallet";

export interface SponsorshipScope {
  environment: ProjectEnvironment;
  organizationId: string;
  projectId: string | null;
  actor: {
    type: SponsorshipActorType;
    id: string;
  };
}

type AppContext = Context<{ Bindings: Env }>;

function requireScopeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AppError("INTERNAL_ERROR", `${label} is required`);
  }
  return encodeURIComponent(normalized);
}

/**
 * Build the only Kora `user_id` shape emitted by authenticated SDP paths.
 *
 * Every segment comes from authentication middleware or persisted tenant data;
 * transaction payloads and public caller input never participate in the quota
 * identity.
 */
export function buildKoraUserId(scope: SponsorshipScope): string {
  const environment = requireScopeSegment(scope.environment, "Sponsorship environment");
  const organizationId = requireScopeSegment(scope.organizationId, "Sponsorship organization id");
  const tenantScope =
    scope.projectId === null
      ? "organization"
      : `project:${requireScopeSegment(scope.projectId, "Sponsorship project id")}`;
  const actorType = requireScopeSegment(scope.actor.type, "Sponsorship actor type");
  const actorId = requireScopeSegment(scope.actor.id, "Sponsorship actor id");

  return `sdp:v1:${environment}:${organizationId}:${tenantScope}:${actorType}:${actorId}`;
}

/** Owned application boundary for constructing a fee-payment provider. */
export function createSponsorshipFeePayment(env: Env, scope: SponsorshipScope): FeePaymentPort {
  return createFeePaymentAdapter(env, buildKoraUserId(scope));
}

/**
 * Compatibility boundary for direct service consumers without tenant context.
 * The adapter emits `sdp:unscoped`, so these callers share a conservative quota
 * bucket instead of bypassing Kora's usage tracker.
 */
export function createUnscopedSponsorshipFeePayment(env: Env): FeePaymentPort {
  return createFeePaymentAdapter(env);
}

/** Resolve a scope exclusively from trusted request middleware state. */
export function resolveRequestSponsorshipScope(c: AppContext): SponsorshipScope {
  const scope = resolveAuthenticatedSponsorshipScope(c);
  return { ...scope, projectId: requireProjectId(c) };
}

/** Resolve either project or organization scope from trusted authentication state. */
export function resolveAuthenticatedSponsorshipScope(c: AppContext): SponsorshipScope {
  const auth = getAuth(c);
  const environment = c.get("projectEnvironment") ?? auth.environment;

  if (environment !== "sandbox" && environment !== "production") {
    throw new AppError("INTERNAL_ERROR", "Sponsorship project environment is unavailable");
  }

  return {
    environment,
    organizationId: auth.organizationId,
    projectId: c.get("projectId") ?? auth.projectId ?? null,
    actor:
      auth.authType === "api_key"
        ? { type: "api_key", id: auth.id }
        : { type: "user", id: auth.id },
  };
}

export function createRequestSponsorshipFeePayment(c: AppContext): FeePaymentPort {
  return createSponsorshipFeePayment(c.env, resolveRequestSponsorshipScope(c));
}

export function createAuthenticatedSponsorshipFeePayment(c: AppContext): FeePaymentPort {
  return createSponsorshipFeePayment(c.env, resolveAuthenticatedSponsorshipScope(c));
}

/**
 * Resolve service/background sponsorship from persisted project ownership.
 * The actor id must itself come from persisted service state (for example a
 * custody wallet id), never a public request field.
 */
export async function createProjectSponsorshipFeePayment(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    actor: SponsorshipScope["actor"];
  }
): Promise<FeePaymentPort> {
  const project = await new ProjectService(getDb(env)).getProject(input.projectId);
  if (!project || project.organizationId !== input.organizationId || project.status !== "active") {
    throw new AppError("FORBIDDEN", "Sponsorship project is not active or accessible");
  }

  return createSponsorshipFeePayment(env, {
    environment: project.environment,
    organizationId: project.organizationId,
    projectId: project.id,
    actor: input.actor,
  });
}
