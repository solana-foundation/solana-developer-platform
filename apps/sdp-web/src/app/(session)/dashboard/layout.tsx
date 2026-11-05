import { INVITATION_EXPIRED_REASON, ORGANIZATION_SUSPENDED_REASON } from "@sdp/types/organizations";
import type { ReactNode } from "react";
import { z } from "zod";
import { AuthPageShell } from "@/components/auth-page-shell";
import {
  type OrganizationRefusal,
  SelectExistingOrganizationPanel,
} from "@/components/select-existing-organization-panel";
import { requestMemberRole, SdpApiResponseError } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";

const refusalBodySchema = z.object({
  error: z.object({ details: z.object({ reason: z.string() }).optional() }),
});

/** The `details.reason` a refusal's body names, if any. */
function refusalReason(responseBody: string): string | undefined {
  try {
    const parsed = refusalBodySchema.safeParse(JSON.parse(responseBody));
    return parsed.success ? parsed.data.error.details?.reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether SDP admits the session to its organization. A Clerk membership grants
 * nothing on its own (ADR 0012): SDP answers 401 for an organization it did not
 * create or a person it never admitted, and 403 `organization_suspended` for a
 * suspended organization (HOO-2009); the page offers the way out instead of an
 * error.
 *
 * @returns "admitted", or why SDP refuses the session's organization.
 */
async function sdpAdmitsSession(): Promise<"admitted" | OrganizationRefusal> {
  try {
    await requestMemberRole();
    return "admitted";
  } catch (error) {
    if (!(error instanceof SdpApiResponseError)) throw error;
    const reason = refusalReason(error.responseBody);
    if (error.status === 403 && reason === ORGANIZATION_SUSPENDED_REASON) {
      return "organization-suspended";
    }
    if (error.status === 401) {
      return reason === INVITATION_EXPIRED_REASON ? "invitation-expired" : "no-access";
    }
    throw error;
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgId } = await getSdpAuth();

  if (!orgId) {
    return (
      <AuthPageShell action={null}>
        <SelectExistingOrganizationPanel refusal={null} />
      </AuthPageShell>
    );
  }

  const admission = await sdpAdmitsSession();
  if (admission !== "admitted") {
    return (
      <AuthPageShell action={null}>
        <SelectExistingOrganizationPanel refusal={admission} />
      </AuthPageShell>
    );
  }

  return children;
}
