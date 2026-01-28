/**
 * Resend email provider
 */

import type { EmailProvider, EmailSendPayload, SendEmailResult } from "../types";

const RESEND_API_URL = "https://api.resend.com/emails";

export interface ResendProviderConfig {
  apiKey: string;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend" as const;
  private apiKey: string;

  constructor(config: ResendProviderConfig) {
    this.apiKey = config.apiKey;
  }

  async send(message: EmailSendPayload): Promise<SendEmailResult> {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: message.replyTo,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Resend error ${response.status}: ${text}`);
    }

    const payload = (await response.json().catch(() => ({}))) as { id?: string };

    return { provider: this.name, id: payload.id };
  }
}
