import type { Context } from "hono";
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

  return { session, memberRole: membership ? membership.role : null };
}

export type OnboardingAccess = Awaited<ReturnType<typeof authorizeOnboardingSession>>;
