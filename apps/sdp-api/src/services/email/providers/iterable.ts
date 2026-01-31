/**
 * Iterable email provider
 *
 * Supports two modes:
 * - Triggered campaign send via /api/email/target (passthrough template).
 * - Legacy inline HTML send via /api/email/send when no campaign is configured.
 *
 * Note: Iterable sends through SES, so the From identity (email or domain)
 * must be verified in the Iterable/SES account or sends will be skipped.
 */

import type { EmailProvider, EmailSendPayload, SendEmailResult } from "../types";

const DEFAULT_ITERABLE_API_BASE = "https://api.iterable.com/api";

export interface IterableProviderConfig {
  apiKey: string;
  passthroughCampaignId?: number;
  apiBaseUrl?: string;
}

export class IterableEmailProvider implements EmailProvider {
  readonly name = "iterable" as const;
  private apiKey: string;
  private apiBaseUrl: string;
  private passthroughCampaignId?: number;

  constructor(config: IterableProviderConfig) {
    this.apiKey = config.apiKey;
    this.passthroughCampaignId = config.passthroughCampaignId;
    this.apiBaseUrl = normalizeApiBase(config.apiBaseUrl ?? DEFAULT_ITERABLE_API_BASE);
  }

  /**
   * Send an email using Iterable
   */
  async send(message: EmailSendPayload): Promise<SendEmailResult> {
    if (this.passthroughCampaignId) {
      return this.sendTriggered(message);
    }

    return this.sendInline(message);
  }

  private async sendTriggered(message: EmailSendPayload): Promise<SendEmailResult> {
    const recipientEmail = message.to[0];
    if (!recipientEmail) {
      throw new Error("Iterable provider requires at least one recipient");
    }

    const dataFields: Record<string, string> = {
      subject: message.subject,
      html: message.html ?? message.text ?? "",
    };

    if (message.text) {
      dataFields.text = message.text;
    }

    const response = await fetch(`${this.apiBaseUrl}/email/target`, {
      method: "POST",
      headers: {
        "Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        campaignId: this.passthroughCampaignId,
        recipientEmail,
        dataFields,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Iterable error ${response.status}: ${text}`);
    }

    const payload = (await response.json().catch(() => ({}))) as IterableSendResponse;

    return { provider: this.name, id: extractMessageId(payload) };
  }

  private async sendInline(message: EmailSendPayload): Promise<SendEmailResult> {
    const recipientEmail = message.to[0];
    if (!recipientEmail) {
      throw new Error("Iterable provider requires at least one recipient");
    }

    const response = await fetch(`${this.apiBaseUrl}/email/send`, {
      method: "POST",
      headers: {
        "Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientEmail,
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

    const payload = (await response.json().catch(() => ({}))) as IterableSendResponse;

    return { provider: this.name, id: extractMessageId(payload) };
  }
}

type IterableSendResponse = {
  messageId?: string;
  params?: {
    id?: string;
    messageId?: string;
  };
};

function normalizeApiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) {
    return trimmed;
  }
  return `${trimmed}/api`;
}

function extractMessageId(payload: IterableSendResponse): string | undefined {
  return payload.messageId ?? payload.params?.messageId ?? payload.params?.id;
}
