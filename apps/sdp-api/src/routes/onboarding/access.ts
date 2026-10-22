import type { Context } from "hono";
import { getDb } from "@/db/client";
import { createOrganizationRepository } from "@/db/repositories/repository-factory";
import { unauthorized } from "@/lib/errors";
import { readActiveOrganizationSettings } from "@/lib/organization-access";
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
  if (membership && membership.status !== "active") {
    throw unauthorized("Organization membership is inactive");
  }
  // A Clerk member SDP never admitted sees the organization only as an
  // invitee about to be admitted by their first request; anyone else holds a
  // Clerk membership that grants nothing (ADR 0012).
  if (!membership) {
    const invitation = await getDb(c.env)
      .prepare(
        `SELECT id FROM invitations
          WHERE organization_id = ? AND LOWER(email) = ? AND status = 'pending' AND expires_at > ?`
      )
      .bind(session.organizationId, session.email.toLowerCase(), new Date().toISOString())
      .first<{ id: string }>();
    if (!invitation) {
      throw unauthorized("No pending invitation to this organization");
    }
  }

  return { session, memberRole: membership ? membership.role : null };
}

export type OnboardingAccess = Awaited<ReturnType<typeof authorizeOnboardingSession>>;
