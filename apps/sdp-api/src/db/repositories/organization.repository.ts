import type { MemberStatus } from "@sdp/types/organizations";
import type { OrganizationRole } from "@sdp/types/roles";

interface OrganizationMembershipRow {
  role: OrganizationRole;
  status: MemberStatus;
}

interface ActiveOrganizationMemberRow {
  memberId: string;
  role: OrganizationRole;
}

export interface OrganizationRepository {
  /**
   * The Clerk user's membership row in the organization, whatever its status.
   *
   * @param params.organizationId - The SDP organization.
   * @param params.clerkUserId - The Clerk user id the session names.
   * @returns The membership, or null when the user has no row yet.
   */
  findMembership(params: {
    organizationId: string;
    clerkUserId: string;
  }): Promise<OrganizationMembershipRow | null>;

  /**
   * The user's active membership in the organization.
   *
   * @param params.organizationId - The SDP organization.
   * @param params.userId - The SDP user.
   * @returns The membership, or null when the user is not an active member.
   */
  findActiveMember(params: {
    organizationId: string;
    userId: string;
  }): Promise<ActiveOrganizationMemberRow | null>;
}
