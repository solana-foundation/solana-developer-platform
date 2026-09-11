import { createSign, generateKeyPairSync } from "node:crypto";
import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { HercleWebhookProcessor, parseHercleWebhookEvent } from "./hercle";

function context(input: {
  headers?: Record<string, string>;
  rawBody?: string;
  env?: Record<string, string | undefined>;
}): RampWebhookValidationContext {
  return {
    env: input.env === undefined ? {} : input.env,
    environment: "sandbox",
    headers: new Headers(input.headers === undefined ? {} : input.headers),
    rawBody: input.rawBody === undefined ? "{}" : input.rawBody,
  };
}

function signedContext(rawBody: string, options: { timestampSeconds?: number } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const timestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const signature = createSign("SHA256")
    .update(`${timestamp}.${rawBody}`)
    .sign(privateKey)
    .toString("base64");
  return {
    publicKey,
    timestamp,
    signature,
    ctx: context({
      env: { HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY: publicKey },
      rawBody,
      headers: { "x-signature": signature, "x-timestamp": timestamp },
    }),
  };
}

describe("HercleWebhookProcessor.verify", () => {
  const env = { HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY: "unused-for-header-checks" };

  it("rejects a missing signature header", async () => {
    await expect(
      new HercleWebhookProcessor().verify(
        context({ env, headers: { "x-timestamp": String(Math.floor(Date.now() / 1000)) } })
      )
    ).rejects.toThrow(AppError);
  });

  it("rejects a missing timestamp header", async () => {
    await expect(
      new HercleWebhookProcessor().verify(context({ env, headers: { "x-signature": "abc" } }))
    ).rejects.toThrow(AppError);
  });

  it("accepts a valid ECDSA signature over timestamp-dot-body and rejects tampering", async () => {
    const rawBody = JSON.stringify({
      event: "ramp.settlement.status_changed",
      timestamp: new Date().toISOString(),
      data: { reference: "ord_1", status: "settled" },
    });
    const { ctx, publicKey, signature, timestamp } = signedContext(rawBody);

    const payload = await new HercleWebhookProcessor().verify(ctx);
    expect(payload).toMatchObject({ event: "ramp.settlement.status_changed" });

    await expect(
      new HercleWebhookProcessor().verify(
        context({
          env: { HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY: publicKey },
          rawBody: `${rawBody} `,
          headers: { "x-signature": signature, "x-timestamp": timestamp },
        })
      )
    ).rejects.toThrow(AppError);
  });

  it("rejects a stale timestamp beyond the 300s window", async () => {
    const rawBody = JSON.stringify({ event: "ping", data: {} });
    const { ctx } = signedContext(rawBody, {
      timestampSeconds: Math.floor(Date.now() / 1000) - 301,
    });

    await expect(new HercleWebhookProcessor().verify(ctx)).rejects.toThrow(AppError);
  });
});

describe("parseHercleWebhookEvent", () => {
  it("parses settlement events with the full status vocabulary", () => {
    for (const status of ["awaiting_payment", "settling", "settled", "failed", "expired"]) {
      expect(
        parseHercleWebhookEvent({
          event: "ramp.settlement.status_changed",
          data: { reference: "ord_1", status, receivedAmount: "99.5" },
        })
      ).toMatchObject({ kind: "settlement", reference: "ord_1", status });
    }
  });

  it("parses verification events onto the internal lifecycle", () => {
    expect(
      parseHercleWebhookEvent({
        event: "customer.verification.status_changed",
        data: { accountId: "acct_1", status: "approved" },
      })
    ).toMatchObject({ kind: "verification", accountId: "acct_1", status: "ready" });
  });

  it("ignores unknown events but fails loudly on a broken envelope", () => {
    expect(parseHercleWebhookEvent({ event: "something.new", data: {} })).toMatchObject({
      kind: "ignore",
    });
    expect(() => parseHercleWebhookEvent({ data: {} })).toThrow(AppError);
    expect(() =>
      parseHercleWebhookEvent({ event: "ramp.settlement.status_changed", data: {} })
    ).toThrow(AppError);
  });

  it("skips unknown settlement statuses instead of guessing", () => {
    expect(
      parseHercleWebhookEvent({
        event: "ramp.settlement.status_changed",
        data: { reference: "ord_1", status: "half-settled" },
      })
    ).toMatchObject({ kind: "ignore" });
  });
});
