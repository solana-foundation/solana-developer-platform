/**
 * Console email provider (development fallback)
 */

import type { EmailProvider, EmailSendPayload, SendEmailResult } from "../types";

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console" as const;

  async send(message: EmailSendPayload): Promise<SendEmailResult> {
    console.log("[EMAIL:console]", {
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    return { provider: this.name, id: `console_${crypto.randomUUID()}` };
  }
}
