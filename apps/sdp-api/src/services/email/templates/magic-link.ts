/**
 * Magic link email template
 */

import type { EmailMessage } from "../types";

export interface MagicLinkEmailParams {
  email: string;
  verifyUrl: string;
  expiresAt: string;
}

export function createMagicLinkEmail(params: MagicLinkEmailParams): EmailMessage {
  const subject = "Your magic link";
  const text = `Use this magic link to sign in (expires at ${params.expiresAt}):\n\n${params.verifyUrl}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <p>Use this magic link to sign in. It expires at <strong>${params.expiresAt}</strong>.</p>
      <p><a href="${params.verifyUrl}">Sign in</a></p>
      <p style="color: #666; font-size: 12px;">If you did not request this link, you can ignore this email.</p>
    </div>
  `;

  return {
    to: [params.email],
    subject,
    text,
    html,
  };
}
