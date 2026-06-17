import type { Env } from "@/types/env";
import { ResendTransactionalEmailDelivery } from "./providers/resend";
import type {
  TransactionalEmailDelivery,
  TransactionalEmailDeliveryPayload,
  TransactionalEmailDeliveryResult,
  TransactionalEmailMessage,
} from "./types";
import { TransactionalEmailError } from "./types";

export class TransactionalEmailService {
  constructor(
    private readonly delivery: TransactionalEmailDelivery,
    private readonly defaultFrom: string
  ) {}

  async send(message: TransactionalEmailMessage): Promise<TransactionalEmailDeliveryResult> {
    const to = message.to.map((recipient) => recipient.trim()).filter(Boolean);
    if (to.length === 0) {
      throw new TransactionalEmailError(
        "invalid_message",
        "Transactional email requires at least one recipient"
      );
    }

    const html = message.html?.trim();
    const text = message.text?.trim();
    if (!html && !text) {
      throw new TransactionalEmailError(
        "invalid_message",
        "Transactional email requires HTML or text content"
      );
    }

    const subject = message.subject.trim();
    if (!subject) {
      throw new TransactionalEmailError(
        "invalid_message",
        "Transactional email requires a subject"
      );
    }

    const from = (message.from ?? this.defaultFrom).trim();
    if (!from) {
      throw new TransactionalEmailError(
        "misconfigured",
        "EMAIL_FROM is required for Transactional Email"
      );
    }

    const payload: TransactionalEmailDeliveryPayload = {
      to,
      subject,
      text,
      html,
      replyTo: message.replyTo?.trim() || undefined,
      from,
    };

    return this.delivery.send(payload);
  }
}

export function createTransactionalEmailService(env: Env): TransactionalEmailService {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new TransactionalEmailError(
      "misconfigured",
      "RESEND_API_KEY is required for Transactional Email"
    );
  }
  const defaultFrom = env.EMAIL_FROM?.trim();
  if (!defaultFrom) {
    throw new TransactionalEmailError(
      "misconfigured",
      "EMAIL_FROM is required for Transactional Email"
    );
  }

  return new TransactionalEmailService(
    new ResendTransactionalEmailDelivery({ apiKey }),
    defaultFrom
  );
}
