import type { Context } from "hono";
import { getDb } from "@/db/client";
import { createOrganizationRepository } from "@/db/repositories/repository-factory";
import { unauthorized } from "@/lib/errors";
import { readActiveOrganizationSettings } from "@/lib/organization-access";
import { findPendingInvitation } from "@/services/organization-membership.service";
import type { Env } from "@/types/env";

export async function authorizeOnboardingSession(c: Context<{ Bindings: Env }>) {
  const session = c.get("clerkOnboarding");
  if (!session) {
    throw unauthorized("Clerk session required");
  }

  if (!session.organizationId) {
    return { session, memberRole: null };
  }

  await readActiveOrganizationSettings(c.env, session.organizationId);

  const membership = await createOrganizationRepository(c.env).findMembership({
    organizationId: session.organizationId,
    clerkUserId: session.clerkUserId,
  });
  // Admission decides the same way: a suspended member is refused, and anyone
  // else without an active membership sees the organization only while an
  // invitation would admit them at their next request (ADR 0012).
  if (membership?.status === "suspended") {
    throw unauthorized("Organization membership is inactive");
  }
  if (membership?.status !== "active") {
    const invitation = await findPendingInvitation(getDb(c.env), {
      organizationId: session.organizationId,
      email: session.email,
    });
    if (!invitation || new Date(invitation.expiresAt) <= new Date()) {
      throw unauthorized("No pending invitation to this organization");
    }
  }

  return { session, memberRole: membership?.status === "active" ? membership.role : null };
}

export type OnboardingAccess = Awaited<ReturnType<typeof authorizeOnboardingSession>>;
