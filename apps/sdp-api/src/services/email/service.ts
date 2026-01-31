/**
 * Email service
 */

import type { Env } from "@/types/env";
import { ConsoleEmailProvider } from "./providers/console";
import { IterableEmailProvider } from "./providers/iterable";
import { ResendEmailProvider } from "./providers/resend";
import type {
  EmailMessage,
  EmailProvider,
  EmailProviderName,
  EmailSendPayload,
  SendEmailResult,
} from "./types";

export class EmailService {
  constructor(
    private provider: EmailProvider,
    private defaultFrom?: string
  ) {}

  async sendEmail(message: EmailMessage): Promise<SendEmailResult> {
    const from =
      message.from ??
      this.defaultFrom ??
      (this.provider.name === "console" ? "console@localhost" : undefined);
    if (!from) {
      throw new Error("Email from address is required");
    }

    const payload: EmailSendPayload = {
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo,
      from,
    };

    return this.provider.send(payload);
  }
}

export function createEmailService(env: Env): EmailService {
  const providerName = resolveProviderName(env);
  const provider = createProvider(providerName, env);
  const defaultFrom = env.EMAIL_FROM;

  return new EmailService(provider, defaultFrom);
}

function resolveProviderName(env: Env): EmailProviderName {
  if (env.EMAIL_PROVIDER) {
    return env.EMAIL_PROVIDER;
  }

  // Prefer Resend for raw HTML sends (React Email)
  if (env.RESEND_API_KEY) {
    return "resend";
  }

  if (env.ITERABLE_API_KEY) {
    return "iterable";
  }

  if (env.ENVIRONMENT === "development") {
    return "console";
  }

  return "console";
}

function createProvider(name: EmailProviderName, env: Env): EmailProvider {
  if (name === "resend") {
    if (!env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required for resend provider");
    }
    return new ResendEmailProvider({ apiKey: env.RESEND_API_KEY });
  }

  if (name === "iterable") {
    if (!env.ITERABLE_API_KEY) {
      throw new Error("ITERABLE_API_KEY is required for iterable provider");
    }
    const passthroughCampaignId = parseIterableCampaignId(
      env.ITERABLE_PASSTHROUGH_CAMPAIGN_ID
    );
    return new IterableEmailProvider({
      apiKey: env.ITERABLE_API_KEY,
      passthroughCampaignId,
      apiBaseUrl: env.ITERABLE_API_BASE_URL,
    });
  }

  return new ConsoleEmailProvider();
}

function parseIterableCampaignId(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error("ITERABLE_PASSTHROUGH_CAMPAIGN_ID must be a number");
  }

  return parsed;
}
