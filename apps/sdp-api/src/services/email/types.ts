/**
 * Email provider abstractions
 */

export type EmailProviderName = "resend" | "console";

export interface EmailMessage {
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
}

export type EmailSendPayload = Omit<EmailMessage, "from"> & { from: string };

export interface SendEmailResult {
  provider: EmailProviderName;
  id?: string;
}

export interface EmailProvider {
  name: EmailProviderName;
  send(message: EmailSendPayload): Promise<SendEmailResult>;
}
