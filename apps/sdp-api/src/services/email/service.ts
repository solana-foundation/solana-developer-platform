import { type CreateEmailOptions, type ErrorResponse, Resend } from "resend";
import type { Env } from "@/types/env";
import type { TransactionalEmailDeliveryResult, TransactionalEmailMessage } from "./types";
import { TransactionalEmailError } from "./types";

type ResendEmailClient = Pick<Resend["emails"], "send">;

export class TransactionalEmailService {
  constructor(
    private readonly emails: ResendEmailClient,
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

    const hasMessageFrom = message.from !== undefined;
    const from = hasMessageFrom ? message.from?.trim() : this.defaultFrom;
    if (!from) {
      if (hasMessageFrom) {
        throw new TransactionalEmailError(
          "invalid_message",
          "Transactional email sender cannot be blank"
        );
      }
      throw new TransactionalEmailError(
        "misconfigured",
        "EMAIL_FROM is required for Transactional Email"
      );
    }

    const replyTo = message.replyTo?.trim() || undefined;
    const payload: CreateEmailOptions = html
      ? {
          from,
          to,
          subject,
          html,
          ...(text ? { text } : {}),
          ...(replyTo ? { replyTo } : {}),
        }
      : {
          from,
          to,
          subject,
          text: text as string,
          ...(replyTo ? { replyTo } : {}),
        };

    try {
      const result = await this.emails.send(payload);
      if (result.error) {
        throw toTransactionalEmailError(result.error);
      }

      return {
        messageId: result.data?.id ?? null,
        acceptedAt: new Date().toISOString(),
      };
    } catch (cause) {
      if (cause instanceof TransactionalEmailError) {
        throw cause;
      }
      throw new TransactionalEmailError("delivery_failed", "Transactional Email delivery failed", {
        cause,
      });
    }
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

  return new TransactionalEmailService(new Resend(apiKey).emails, defaultFrom);
}

function toTransactionalEmailError(error: ErrorResponse): TransactionalEmailError {
  return new TransactionalEmailError("delivery_failed", error.message, {
    status: error.statusCode ?? undefined,
    details: error,
  });
}
