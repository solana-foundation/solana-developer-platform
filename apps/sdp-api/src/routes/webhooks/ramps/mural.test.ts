import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import type { RampWebhookValidationContext } from "@/lib/ramps/types";
import { MuralWebhookProcessor } from "./mural";

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

describe("MuralWebhookProcessor.verify", () => {
  const env = { MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY: "unused-for-header-checks" };

  it("rejects a missing signature header", async () => {
    const processor = new MuralWebhookProcessor();

    await expect(
      processor.verify(
        context({ env, headers: { "x-mural-webhook-timestamp": new Date().toISOString() } })
      )
    ).rejects.toThrow(AppError);
  });

  it("rejects a missing timestamp header", async () => {
    const processor = new MuralWebhookProcessor();

    await expect(
      processor.verify(context({ env, headers: { "x-mural-webhook-signature": "abc" } }))
    ).rejects.toThrow(AppError);
  });

  it("accepts a valid ECDSA signature over timestamp-dot-body and rejects tampering", async () => {
    const processor = new MuralWebhookProcessor();
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const rawBody = JSON.stringify({
      payload: { type: "tos_accepted", organizationId: "org_9" },
    });
    const timestamp = new Date().toISOString();
    const signature = createSign("SHA256")
      .update(`${timestamp}.${rawBody}`)
      .sign(privateKey)
      .toString("base64");
    const signedEnv = { MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY: publicKey };
    const headers = {
      "x-mural-webhook-signature": signature,
      "x-mural-webhook-timestamp": timestamp,
    };

    const result = await processor.verify(context({ env: signedEnv, rawBody, headers }));
    expect(result).toEqual({ payload: { type: "tos_accepted", organizationId: "org_9" } });

    await expect(
      processor.verify(context({ env: signedEnv, rawBody: `${rawBody} `, headers }))
    ).rejects.toThrow(AppError);
  });
});

describe("MuralWebhookProcessor.parse", () => {
  it("delegates Mural event parsing", () => {
    const processor = new MuralWebhookProcessor();

    expect(
      processor.parse({
        payload: { type: "tos_accepted", organizationId: "org_9" },
      })
    ).toEqual({ kind: "tos_accepted", organizationId: "org_9" });
  });
});
