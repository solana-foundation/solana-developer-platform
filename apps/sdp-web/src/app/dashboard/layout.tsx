import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SelectExistingOrganizationPanel } from "@/components/select-existing-organization-panel";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { requestMemberRole, SdpApiResponseError } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";

/**
 * Whether SDP admits the session to its organization. A Clerk membership grants
 * nothing on its own (ADR 0012): SDP answers 401 for an organization it did not
 * create or a person it never admitted, and the page offers the way out
 * instead of an error.
 *
 * @returns False when SDP refuses the session's organization.
 */
async function sdpAdmitsSession(): Promise<boolean> {
  try {
    await requestMemberRole();
    return true;
  } catch (error) {
    if (error instanceof SdpApiResponseError && error.status === 401) {
      return false;
    }
    throw error;
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgId, userId } = await getSdpAuth();

  if (!userId) {
    redirect(await getAuthEntryPath());
  }

  if (!orgId) {
    return <SelectExistingOrganizationPanel noAccess={false} />;
  }

  if (!(await sdpAdmitsSession())) {
    return <SelectExistingOrganizationPanel noAccess />;
  }

  return children;
}
