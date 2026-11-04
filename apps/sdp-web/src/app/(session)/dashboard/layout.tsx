import type { ReactNode } from "react";
import { AuthPageShell } from "@/components/auth-page-shell";
import {
  SelectExistingOrganizationPanel,
  type SessionOrganization,
} from "@/components/select-existing-organization-panel";
import { requestMemberRole, requestOnboardingStatus, SdpApiResponseError } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";

/**
 * How SDP stands toward the session's organization. A Clerk membership grants
 * nothing on its own (ADR 0012): SDP answers 401 for an organization it did not
 * create or a person it never admitted, and the page offers the way out
 * instead of an error.
 *
 * @returns `null` when SDP admits the session, else why it does not.
 */
async function sessionOrganizationRefusal(): Promise<Exclude<SessionOrganization, "none"> | null> {
  try {
    await requestMemberRole();
    return null;
  } catch (error) {
    if (!(error instanceof SdpApiResponseError && error.status === 401)) {
      throw error;
    }
  }
  // One Clerk instance serves several deployments, so the session's organization may be
  // one another deployment created, which SDP here answers `linked: false` for.
  return (await requestOnboardingStatus()).linked ? "refused" : "unlinked";
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgId } = await getSdpAuth();

  if (!orgId) {
    return (
      <AuthPageShell action={null}>
        <SelectExistingOrganizationPanel sessionOrganization="none" />
      </AuthPageShell>
    );
  }

  const refusal = await sessionOrganizationRefusal();
  if (refusal !== null) {
    return (
      <AuthPageShell action={null}>
        <SelectExistingOrganizationPanel sessionOrganization={refusal} />
      </AuthPageShell>
    );
  }

  return children;
}
