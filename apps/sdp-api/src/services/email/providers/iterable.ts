/**
 * Iterable email provider
 *
 * Uses Iterable's /api/email/send endpoint for transactional emails
 * with inline HTML content rendered from React Email templates.
 */

import type { EmailProvider, EmailSendPayload, SendEmailResult } from "../types";

const ITERABLE_API_BASE = "https://api.iterable.com/api";

export interface IterableProviderConfig {
  apiKey: string;
}

export class IterableEmailProvider implements EmailProvider {
  readonly name = "iterable" as const;
  private apiKey: string;

  constructor(config: IterableProviderConfig) {
    this.apiKey = config.apiKey;
  }

  /**
   * Send an email with inline HTML content
   */
  async send(message: EmailSendPayload): Promise<SendEmailResult> {
    const response = await fetch(`${ITERABLE_API_BASE}/email/send`, {
      method: "POST",
      headers: {
        "Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientEmail: message.to[0],
        from: message.from,
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Iterable error ${response.status}: ${text}`);
    }

    const payload = (await response.json().catch(() => ({}))) as {
      messageId?: string;
    };

    return { provider: this.name, id: payload.messageId };
  }
}
