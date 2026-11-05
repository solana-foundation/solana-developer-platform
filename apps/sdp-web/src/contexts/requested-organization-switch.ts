// The organization this tab asked Clerk for through the workspace provider's
// `switchOrganization`, kept for the tab rather than one provider: until the
// server renders it the provider remounts per server scope, and only this switch
// may move the tab off its URL (HOO-2622). `settled` turns true once Clerk has
// made it active; before that the page still renders the previous organization.
let request: { organizationId: string; settled: boolean } | null = null;

export function requestOrganizationSwitch(organizationId: string): void {
  request = { organizationId, settled: false };
}

export function settleOrganizationSwitch(organizationId: string): void {
  if (request?.organizationId === organizationId) {
    request.settled = true;
  }
}

export function requestedOrganizationSwitch(): string | null {
  return request?.organizationId ?? null;
}

// Clerk and the server agree on `organizationId`. That ends the request once it
// is the requested organization, or once Clerk settled the request and has
// since moved on, so a later mismatch is not this tab's switch.
export function settleOrganizationSwitchOnRender(organizationId: string): void {
  if (request && (request.organizationId === organizationId || request.settled)) {
    request = null;
  }
}

export function clearOrganizationSwitch(): void {
  request = null;
}
