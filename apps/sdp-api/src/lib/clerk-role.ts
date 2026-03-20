import type { OrganizationRole } from "@sdp/types";

export function mapClerkRoleToOrgRole(role: string | null | undefined): OrganizationRole {
  if (role === "org:admin") {
    return "admin";
  }
  return "member";
}
