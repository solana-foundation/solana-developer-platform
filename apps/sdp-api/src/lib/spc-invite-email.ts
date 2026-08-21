// Invite-email scaffold. Real integration deferred until email provider is
// wired for this surface; the invite URL is returned in the response body, which
// is where an admin copies it from.

import { maskEmail } from "@sdp/redaction";
import { getLogger } from "@/runtime/logger";

export interface SendInviteEmailInput {
  to: string;
  inviteUrl: string;
  invitedByName: string | null;
}

export async function sendInviteEmail(input: SendInviteEmailInput): Promise<void> {
  // Neither the recipient nor the URL is logged in full. The URL embeds the
  // invite token, so whoever reads the line can accept the invitation — it is a
  // bearer credential, and log retention is not where credentials belong. The
  // masked recipient is enough to tie the line to an invitation.
  getLogger().info(
    { to: maskEmail(input.to) },
    "[spc-invite-email] TODO: wire real provider; invite URL is in the response body"
  );
}
