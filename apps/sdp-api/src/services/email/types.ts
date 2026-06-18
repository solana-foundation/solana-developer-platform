export interface TransactionalEmailMessage {
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
}

export interface TransactionalEmailDeliveryResult {
  messageId: string | null;
  acceptedAt: string;
}

export type TransactionalEmailErrorCode = "misconfigured" | "invalid_message" | "delivery_failed";

export interface TransactionalEmailErrorOptions {
  status?: number;
  details?: unknown;
  cause?: unknown;
}

export class TransactionalEmailError extends Error {
  readonly code: TransactionalEmailErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(
    code: TransactionalEmailErrorCode,
    message: string,
    options: TransactionalEmailErrorOptions = {}
  ) {
    super(message);
    this.name = "TransactionalEmailError";
    this.code = code;
    this.status = options.status;
    this.details = options.details;
    this.cause = options.cause;
  }
}
