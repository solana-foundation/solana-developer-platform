import type { MemberStatus } from "@sdp/types/organizations";
import type { OrganizationRole } from "@sdp/types/roles";

export interface OrganizationMembershipRow {
  role: OrganizationRole;
  status: MemberStatus;
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
}
