import { describe, expect, it, vi } from "vitest";
import { TransactionalEmailError } from "../types";
import { ResendTransactionalEmailDelivery } from "./resend";

describe("ResendTransactionalEmailDelivery", () => {
  it("posts normalized Transactional Email payloads to Resend", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "em_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const delivery = new ResendTransactionalEmailDelivery({
      apiKey: "re_test",
      fetcher,
    });

    const result = await delivery.send({
      from: "noreply@mail.solana.org",
      to: ["payer@example.com"],
      subject: "Payment request",
      html: "<p>Pay now</p>",
      text: "Pay now",
      replyTo: "support@solana.org",
    });

    expect(result).toMatchObject({ messageId: "em_123" });
    expect(new Date(result.acceptedAt).toString()).not.toBe("Invalid Date");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer re_test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "noreply@mail.solana.org",
      to: ["payer@example.com"],
      subject: "Payment request",
      html: "<p>Pay now</p>",
      text: "Pay now",
      reply_to: "support@solana.org",
    });
  });

  it.each([
    [401, "misconfigured"],
    [422, "rejected"],
    [429, "retryable"],
    [503, "retryable"],
  ] as const)("maps Resend HTTP %s to %s", async (status, code) => {
    const delivery = new ResendTransactionalEmailDelivery({
      apiKey: "re_test",
      fetcher: vi.fn().mockResolvedValue(new Response("nope", { status })),
    });

    await expect(
      delivery.send({
        from: "noreply@mail.solana.org",
        to: ["payer@example.com"],
        subject: "Payment request",
        html: "<p>Pay now</p>",
      })
    ).rejects.toMatchObject({
      code,
      status,
      details: "nope",
    });
  });

  it("maps network failures to retryable delivery errors", async () => {
    const delivery = new ResendTransactionalEmailDelivery({
      apiKey: "re_test",
      fetcher: vi.fn().mockRejectedValue(new Error("network down")),
    });

    await expect(
      delivery.send({
        from: "noreply@mail.solana.org",
        to: ["payer@example.com"],
        subject: "Payment request",
        html: "<p>Pay now</p>",
      })
    ).rejects.toMatchObject({
      code: "retryable",
    });
  });

  it("uses a custom base URL without leaking it into callers", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const delivery = new ResendTransactionalEmailDelivery({
      apiKey: "re_test",
      baseUrl: "https://resend.test/",
      fetcher,
    });

    await delivery.send({
      from: "noreply@mail.solana.org",
      to: ["payer@example.com"],
      subject: "Payment request",
      html: "<p>Pay now</p>",
    });

    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://resend.test/emails");
  });

  it("throws TransactionalEmailError instances", async () => {
    const delivery = new ResendTransactionalEmailDelivery({
      apiKey: "re_test",
      fetcher: vi.fn().mockResolvedValue(new Response("nope", { status: 400 })),
    });

    await expect(
      delivery.send({
        from: "noreply@mail.solana.org",
        to: ["payer@example.com"],
        subject: "Payment request",
        html: "<p>Pay now</p>",
      })
    ).rejects.toBeInstanceOf(TransactionalEmailError);
  });
});
