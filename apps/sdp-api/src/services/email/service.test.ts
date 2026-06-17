import { describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { createTransactionalEmailService, TransactionalEmailService } from "./service";
import type { TransactionalEmailDelivery } from "./types";
import { TransactionalEmailError } from "./types";

describe("TransactionalEmailService", () => {
  it("normalizes message input and applies the default sender", async () => {
    const delivery: TransactionalEmailDelivery = {
      send: vi.fn().mockResolvedValue({
        messageId: "em_123",
        acceptedAt: "2026-01-01T00:00:00.000Z",
      }),
    };
    const service = new TransactionalEmailService(delivery, "noreply@mail.solana.org");

    await expect(
      service.send({
        to: [" payer@example.com ", ""],
        subject: " Payment request ",
        html: " <p>Pay now</p> ",
        replyTo: " support@mail.solana.org ",
      })
    ).resolves.toEqual({
      messageId: "em_123",
      acceptedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(delivery.send).toHaveBeenCalledWith({
      to: ["payer@example.com"],
      from: "noreply@mail.solana.org",
      subject: "Payment request",
      html: "<p>Pay now</p>",
      text: undefined,
      replyTo: "support@mail.solana.org",
    });
  });

  it("rejects messages without recipients or content", async () => {
    const service = new TransactionalEmailService({ send: vi.fn() }, "noreply@mail.solana.org");

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
