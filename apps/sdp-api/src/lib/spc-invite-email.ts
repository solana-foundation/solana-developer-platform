// Invite-email scaffold. Real integration deferred until email provider is
// wired for this surface; for now, log the invite URL so admins can copy it
// out of the API's stdout (or the returned response body).

import { getLogger } from "@/runtime/logger";

export interface SendInviteEmailInput {
  to: string;
  inviteUrl: string;
  invitedByName: string | null;
}

export async function sendInviteEmail(input: SendInviteEmailInput): Promise<void> {
  getLogger().info({ input }, "[spc-invite-email] TODO: wire real provider");
}
