import type { CreateEmailResponse, Resend } from "resend";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { createTransactionalEmailService, TransactionalEmailService } from "./service";
import { TransactionalEmailError } from "./types";

type ResendEmails = Pick<Resend["emails"], "send">;

describe("TransactionalEmailService", () => {
  it("normalizes message input and applies the default sender", async () => {
    const send = vi.fn().mockResolvedValue({
      data: { id: "em_123" },
      error: null,
      headers: {},
    } satisfies CreateEmailResponse);
    const service = new TransactionalEmailService(
      { send } as ResendEmails,
      "noreply@mail.solana.org"
    );

    const result = await service.send({
      to: [" payer@example.com ", ""],
      subject: " Payment request ",
      html: " <p>Pay now</p> ",
      replyTo: " support@mail.solana.org ",
    });

    expect(result.messageId).toBe("em_123");
    expect(new Date(result.acceptedAt).toString()).not.toBe("Invalid Date");
    expect(send).toHaveBeenCalledWith({
      to: ["payer@example.com"],
      from: "noreply@mail.solana.org",
      subject: "Payment request",
      html: "<p>Pay now</p>",
      replyTo: "support@mail.solana.org",
    });
  });

  it("rejects messages without recipients or content", async () => {
    const service = new TransactionalEmailService(
      { send: vi.fn() } as ResendEmails,
      "noreply@mail.solana.org"
    );

    await expect(
      service.send({ to: [], subject: "Payment request", html: "<p>Pay now</p>" })
    ).rejects.toMatchObject({
      code: "invalid_message",
      message: "Transactional email requires at least one recipient",
    });

    await expect(
      service.send({ to: ["payer@example.com"], subject: "Payment request" })
    ).rejects.toMatchObject({
      code: "invalid_message",
      message: "Transactional email requires HTML or text content",
    });

    await expect(
      service.send({ to: ["payer@example.com"], subject: "   ", text: "Pay now" })
    ).rejects.toMatchObject({
      code: "invalid_message",
      message: "Transactional email requires a subject",
    });

    await expect(
      service.send({
        to: ["payer@example.com"],
        from: "   ",
        subject: "Payment request",
        text: "Pay now",
      })
    ).rejects.toMatchObject({
      code: "invalid_message",
      message: "Transactional email sender cannot be blank",
    });
  });

  it("maps Resend SDK errors without maintaining provider-specific status rules", async () => {
    const resendError = {
      name: "rate_limit_exceeded",
      statusCode: 429,
      message: "Too many requests",
    } as const;
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: resendError,
      headers: {},
    } satisfies CreateEmailResponse);
    const service = new TransactionalEmailService(
      { send } as ResendEmails,
      "noreply@mail.solana.org"
    );

    await expect(
      service.send({
        to: ["payer@example.com"],
        subject: "Payment request",
        text: "Pay now",
      })
    ).rejects.toMatchObject({
      code: "delivery_failed",
      status: 429,
      details: resendError,
      message: "Too many requests",
    });
  });

  it("returns a null message id when Resend succeeds without response data", async () => {
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: null,
      headers: {},
    });
    const service = new TransactionalEmailService(
      { send } as ResendEmails,
      "noreply@mail.solana.org"
    );

    await expect(
      service.send({
        to: ["payer@example.com"],
        subject: "Payment request",
        text: "Pay now",
      })
    ).resolves.toMatchObject({ messageId: null });
  });

  it("fails clearly when Resend configuration is missing", () => {
    expect(() => createTransactionalEmailService({} as Env)).toThrow(TransactionalEmailError);
    expect(() =>
      createTransactionalEmailService({
        RESEND_API_KEY: "re_test",
      } as Env)
    ).toThrow(/EMAIL_FROM/);
    expect(() =>
      createTransactionalEmailService({
        RESEND_API_KEY: "   ",
        EMAIL_FROM: "noreply@mail.solana.org",
      } as Env)
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      createTransactionalEmailService({
        RESEND_API_KEY: "re_test",
        EMAIL_FROM: "   ",
      } as Env)
    ).toThrow(/EMAIL_FROM/);
  });
});
