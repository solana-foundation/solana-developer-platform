/**
 * Invitation email template
 */

import type { EmailMessage } from "../types";

export interface InvitationEmailParams {
  email: string;
  inviterEmail?: string;
  organizationName?: string;
  role: string;
  inviteUrl: string;
  expiresAt: string;
}

export function createInvitationEmail(params: InvitationEmailParams): EmailMessage {
  const orgLabel = params.organizationName ?? "the organization";
  const subject = `You're invited to join ${orgLabel}`;
  const intro = params.inviterEmail
    ? `${params.inviterEmail} invited you to join ${orgLabel} as ${params.role}.`
    : `You've been invited to join ${orgLabel} as ${params.role}.`;

  const text = `${intro}\n\nAccept the invitation (expires at ${params.expiresAt}):\n${params.inviteUrl}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <p>${intro}</p>
      <p>This invite expires at <strong>${params.expiresAt}</strong>.</p>
      <p><a href="${params.inviteUrl}">Accept invitation</a></p>
      <p style="color: #666; font-size: 12px;">If you were not expecting this invite, you can ignore this email.</p>
    </div>
  `;

  return {
    to: [params.email],
    subject,
    text,
    html,
  };
}
