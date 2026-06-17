import type {
  TransactionalEmailDelivery,
  TransactionalEmailDeliveryPayload,
  TransactionalEmailDeliveryResult,
} from "../types";
import { TransactionalEmailError, type TransactionalEmailErrorCode } from "../types";

const RESEND_API_BASE = "https://api.resend.com";

type Fetcher = typeof fetch;

export interface ResendTransactionalEmailConfig {
  apiKey: string;
  baseUrl?: string;
  fetcher?: Fetcher;
}

export class ResendTransactionalEmailDelivery implements TransactionalEmailDelivery {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;

  constructor(config: ResendTransactionalEmailConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl?.replace(/\/$/, "") ?? RESEND_API_BASE;
    this.fetcher = config.fetcher ?? fetch;
  }

  async send(
    message: TransactionalEmailDeliveryPayload
  ): Promise<TransactionalEmailDeliveryResult> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/emails`, {
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
    } catch (cause) {
      throw new TransactionalEmailError(
        "retryable",
        "Transactional Email delivery failed before Resend accepted it",
        { cause }
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const code = classifyResendFailure(response.status);
      throw new TransactionalEmailError(
        code,
        `Transactional Email delivery ${deliveryFailureLabel(code)}`,
        {
          status: response.status,
          details: body,
        }
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      id?: string;
    };

    return {
      messageId: typeof payload.id === "string" ? payload.id : null,
      acceptedAt: new Date().toISOString(),
    };
  }
}

function classifyResendFailure(status: number): TransactionalEmailErrorCode {
  if (status === 401 || status === 403) {
    return "misconfigured";
  }
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
    return "retryable";
  }
  if (status >= 400 && status < 500) {
    return "rejected";
  }
  return "unknown";
}

function deliveryFailureLabel(code: TransactionalEmailErrorCode): string {
  switch (code) {
    case "misconfigured":
      return "is misconfigured";
    case "rejected":
      return "was rejected";
    case "retryable":
      return "can be retried";
    case "invalid_message":
      return "has an invalid message";
    case "unknown":
      return "failed";
  }
}
