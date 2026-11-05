// The organization this tab asked Clerk for through the workspace provider's
// `switchOrganization`, kept for the tab rather than one provider: until the
// server renders it the provider remounts per server scope, and only this switch
// may move the tab off its URL (HOO-2622).
let requestedOrganizationId: string | null = null;

export function requestOrganizationSwitch(organizationId: string): void {
  requestedOrganizationId = organizationId;
}

export function requestedOrganizationSwitch(): string | null {
  return requestedOrganizationId;
}

export function clearOrganizationSwitch(): void {
  requestedOrganizationId = null;
}
