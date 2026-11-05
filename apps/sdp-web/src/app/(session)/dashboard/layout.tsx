import { INVITATION_EXPIRED_REASON } from "@sdp/types/organizations";
import type { ReactNode } from "react";
import { z } from "zod";
import { AuthPageShell } from "@/components/auth-page-shell";
import { SelectExistingOrganizationPanel } from "@/components/select-existing-organization-panel";
import { requestMemberRole, SdpApiResponseError } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";

const refusalBodySchema = z.object({
  error: z.object({ details: z.object({ reason: z.string() }).optional() }),
});

/** Whether a refusal's body says the person's invitation expired. */
function refusedForExpiredInvitation(responseBody: string): boolean {
  try {
    const parsed = refusalBodySchema.safeParse(JSON.parse(responseBody));
    return parsed.success && parsed.data.error.details?.reason === INVITATION_EXPIRED_REASON;
  } catch {
    return false;
  }
}

/**
 * Whether SDP admits the session to its organization. A Clerk membership grants
 * nothing on its own (ADR 0012): SDP answers 401 for an organization it did not
 * create or a person it never admitted, and the page offers the way out
 * instead of an error.
 *
 * @returns "admitted", or why SDP refuses the session's organization.
 */
async function sdpAdmitsSession(): Promise<"admitted" | "no-access" | "invitation-expired"> {
  try {
    await requestMemberRole();
    return "admitted";
  } catch (error) {
    if (error instanceof SdpApiResponseError && error.status === 401) {
      return refusedForExpiredInvitation(error.responseBody) ? "invitation-expired" : "no-access";
    }
    throw error;
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgId } = await getSdpAuth();

  if (!orgId) {
    return (
      <AuthPageShell action={null}>
        <SelectExistingOrganizationPanel noAccess={false} invitationExpired={false} />
      </AuthPageShell>
    );
  }

  const admission = await sdpAdmitsSession();
  if (admission !== "admitted") {
    return (
      <AuthPageShell action={null}>
        <SelectExistingOrganizationPanel
          noAccess
          invitationExpired={admission === "invitation-expired"}
        />
      </AuthPageShell>
    );
  }

  return children;
}
