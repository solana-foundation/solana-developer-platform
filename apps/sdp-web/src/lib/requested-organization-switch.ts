// The organization this tab asked Clerk for through the workspace provider's
// `switchOrganization`, kept for the tab rather than one provider: until the
// server renders it the provider remounts per server scope, and only this switch
// may move the tab off its URL (HOO-2622).
let requestedOrganizationId: string | null = null;

/** Records the organization this tab asked Clerk to make active. */
export function requestOrganizationSwitch(organizationId: string): void {
  requestedOrganizationId = organizationId;
}

/** The organization this tab asked for and the server has not rendered yet, if any. */
export function requestedOrganizationSwitch(): string | null {
  return requestedOrganizationId;
}

/** Forgets the request: the server rendered it, or Clerk refused it. */
export function clearOrganizationSwitch(): void {
  requestedOrganizationId = null;
}
