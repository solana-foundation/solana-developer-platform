export type OrganizationRole = "owner" | "admin" | "developer" | "viewer";

export function mapClerkRoleToOrgRole(role: string | null | undefined): OrganizationRole {
  if (role === "org:owner") {
    return "owner";
  }
  if (role === "org:admin") {
    return "admin";
  }
  return "developer";
}
