import { SigningError } from "@sdp/custody/signing";
import { FeePaymentError } from "@sdp/fee-payment/port";
import { SdpPaymentsError } from "@sdp/payments/errors";
import { SdpRpcError } from "@sdp/rpc/errors";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types/release-channels";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp, type SdpPlugin } from "@/app";
import { DatabaseUnavailableError } from "@/db/client";
import { AppError } from "@/lib/errors";
import { type ValidatedBodyContext, validateBody } from "@/middleware/validate";
import { rootLogger } from "@/runtime/logger";
import { env as baseEnv } from "@/test/helpers/env";
import { clearKVStores } from "@/test/mocks/kv";

const THROW_PATH = "/__internal_error_test_throw";
const VALIDATED_BODY_PATH = "/__internal_error_test_validated_body";
const validatedBodySchema = z.object({ name: z.string() });
const SECRET_APP_ERROR_PATH = "/__secret_app_error_test_throw";
const SECRET_RPC_ERROR_PATH = "/__secret_rpc_error_test_throw";
const SECRET_PAYMENTS_ERROR_PATH = "/__secret_payments_error_test_throw";
const SECRET_SIGNING_ERROR_PATH = "/__secret_signing_error_test_throw";
const SECRET_UNEXPECTED_ERROR_PATH = "/__secret_unexpected_error_test_throw";
const FEE_ERROR_PATH = "/__fee_error_test_throw";
const FEE_REJECTED_PATH = "/__fee_rejected_test_throw";
const FEE_AMBIGUOUS_PATH = "/__fee_ambiguous_test_throw";
const FEE_UNAVAILABLE_PATH = "/__fee_unavailable_test_throw";
const FEE_NETWORK_PATH = "/__fee_network_test_throw";
const FEE_RATE_LIMITED_PATH = "/__fee_rate_limited_test_throw";
const PII_UNEXPECTED_ERROR_PATH = "/__pii_unexpected_error_test_throw";
const IDEMPOTENCY_REUSED_PATH = "/__idempotency_reused_test_throw";
const DATABASE_UNAVAILABLE_PATH = "/__database_unavailable_test_throw";

function buildApp() {
  const app = createApp({ rampProviderStages: SDP_RAMP_PROVIDER_STAGES });
  // Mount a route that throws after createApp returns, so we exercise the
  // onError path without modifying the production createApp surface.
  app.all(THROW_PATH, () => {
    throw new Error("test trigger for onError");
  });
  app.all(SECRET_APP_ERROR_PATH, () => {
    throw new AppError("BAD_REQUEST", "Invalid appSecret=privy-secret", {
      appSecret: "privy-secret",
      tokenId: "tok_public",
    });
  });
  app.all(SECRET_RPC_ERROR_PATH, () => {
    throw new SdpRpcError("SOLANA_RPC_ERROR", "Invalid apiKey=rpc-secret", {
      apiKey: "rpc-secret",
      endpoint: "https://rpc.example",
    });
  });
  app.all(SECRET_PAYMENTS_ERROR_PATH, () => {
    throw new SdpPaymentsError(
      "PROVIDER_UNAVAILABLE",
      "Invalid apiKey=ramp-secret",
      { apiKey: "ramp-secret", provider: "moonpay" },
      { providerMessage: "quote service down for jane.doe@example.com" }
    );
  });
  app.all(SECRET_SIGNING_ERROR_PATH, () => {
    throw new SigningError(
      'Privy API error: 401 - {"appSecret":"privy-secret"}',
      "PROVIDER_NOT_CONFIGURED"
    );
  });
  app.all(SECRET_UNEXPECTED_ERROR_PATH, () => {
    throw Object.assign(new Error("privateKey=raw-private-key"), {
      context: { authorization: "Bearer raw-token" },
      cause: { password: "pw" },
    });
  });
  // A counterparty failure as a provider actually reports it: the submitted
  // identity echoed back in the message, and the request payload hung off the
  // error as `context`.
  app.all(PII_UNEXPECTED_ERROR_PATH, () => {
    throw Object.assign(new Error("Provider rejected jane.doe@example.com (phone=+15551234567)"), {
      context: {
        counterpartyId: "cp_1",
        identity: { firstName: "Jane", lastName: "Doe", dateOfBirth: "1988-04-02" },
        walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      },
      cause: { accountNumber: "000123456789" },
    });
  });
  app.all(FEE_ERROR_PATH, () => {
    throw new FeePaymentError(
      "Failed to sign and send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
      "SIGNING_FAILED"
    );
  });
  app.all(IDEMPOTENCY_REUSED_PATH, () => {
    throw new AppError("IDEMPOTENCY_KEY_REUSED");
  });
  app.all(DATABASE_UNAVAILABLE_PATH, () => {
    throw new DatabaseUnavailableError(new Error("timeout exceeded when trying to connect"), {
      totalCount: 10,
      idleCount: 0,
      waitingCount: 42,
    });
  });
  app.all(FEE_REJECTED_PATH, () => {
    throw new FeePaymentError(
      "Failed to sign transaction as fee payer: Kora Error -32001: Validation error: Mutable transfer-hook authority found on mint account CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
      "PROVIDER_REJECTED"
    );
  });
  app.all(FEE_UNAVAILABLE_PATH, () => {
    throw new FeePaymentError("Kora breaker open", "PROVIDER_NOT_AVAILABLE");
  });
  app.all(FEE_NETWORK_PATH, () => {
    throw new FeePaymentError(
      "Failed to get fee payer address: Unexpected token '<'",
      "NETWORK_ERROR"
    );
  });
  app.all(FEE_RATE_LIMITED_PATH, () => {
    throw new FeePaymentError("Kora rate limited", "RATE_LIMITED");
  });
  app.all(FEE_AMBIGUOUS_PATH, () => {
    throw new FeePaymentError("KMS response timed out after signing", "SIGNING_FAILED");
  });
  return app;
}

describe("createApp onError HTTPException mapping", () => {
  it("maps malformed JSON on a validated route to the standard 400 envelope", async () => {
    const app = buildApp();
    app.post(
      VALIDATED_BODY_PATH,
      validateBody(validatedBodySchema),
      (c: ValidatedBodyContext<typeof validatedBodySchema>) => c.json(c.req.valid("json"))
    );

    const res = await app.request(
      VALIDATED_BODY_PATH,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      },
      baseEnv
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Malformed JSON in request body");
  });
});

describe("createApp plugin registration", () => {
  it("registers plugin routes under /v1", async () => {
    const plugin: SdpPlugin = {
      name: "test-plugin",
      register(v1) {
        v1.get("/test-plugin", (c) => c.json({ ok: true }));
      },
    };
    const app = createApp({
      rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
      plugins: [plugin],
    });

    const res = await app.request("/v1/test-plugin", {}, baseEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects a /v1 body above the global backstop limit with 413", async () => {
    const plugin: SdpPlugin = {
      name: "body-limit-test",
      register(v1) {
        v1.post("/body-limit-test", (c) => c.json({ ok: true }));
      },
    };
    const app = createApp({
      rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
      plugins: [plugin],
    });

    const res = await app.request(
      "/v1/body-limit-test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(1024 * 1024 + 1),
      },
      baseEnv
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 404 for an unregistered route when no plugins are passed", async () => {
    const app = createApp({ rampProviderStages: SDP_RAMP_PROVIDER_STAGES });

    const res = await app.request("/v1/test-plugin", {}, baseEnv);

    expect(res.status).toBe(404);
  });

  it("throws when two plugins share the same name", () => {
    const make = (name: string): SdpPlugin => ({ name, register: () => {} });

    expect(() =>
      createApp({
        rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
        plugins: [make("dup"), make("dup")],
      })
    ).toThrow(/dup/);
  });
});

describe("createApp onError", () => {
  beforeEach(async () => {
    // These requests are anonymous, so they share the per-IP anonymous window
    // with every suite this worker ran in the same minute; start it empty.
    await clearKVStores(baseEnv);
  });

  it("answers an unexpected error with the 500 INTERNAL_ERROR envelope", async () => {
    const app = buildApp();

    const res = await app.request(THROW_PATH, {}, baseEnv);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("maps fee payment program errors to product-safe messages", async () => {
    const app = buildApp();

    const res = await app.request(FEE_ERROR_PATH, {}, baseEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("TRANSACTION_FAILED");
    expect(body.error.message).toBe(
      "The wallet used for this payment does not have enough funds. Add funds and try again."
    );
    expect(body.error.message).not.toContain("custom program error");
  });

  it("answers 503 with Retry-After when the database could not take the request", async () => {
    const app = buildApp();

    const res = await app.request(DATABASE_UNAVAILABLE_PATH, {}, baseEnv);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    // The pool's own wording stays in the logs, not in the response.
    expect(text).not.toContain("timeout exceeded");
  });

  // HOO-1918: the IETF draft's 422 for a reused Idempotency-Key must reach the
  // client as 422, not fall through the status whitelist to 500.
  it("answers an AppError's 422 as 422", async () => {
    const app = buildApp();

    const res = await app.request(IDEMPOTENCY_REUSED_PATH, {}, baseEnv);

    expect(res.status).toBe(422);
    const body = z.object({ error: z.object({ code: z.string() }) }).parse(await res.json());
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("maps deterministic signing rejections to a 422 that does not ask for a retry", async () => {
    const app = buildApp();

    const res = await app.request(FEE_REJECTED_PATH, {}, baseEnv);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("SIGNING_REJECTED");
    expect(body.error.message).not.toContain("Try again");
    expect(body.error.message).not.toContain("temporarily unavailable");
    expect(body.error.message).not.toContain("CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM");
  });

  // A sponsor outage is not a custody outage. The copy used to say "signing
  // provider", which sent whoever read it to check custody.
  it.each([
    [FEE_UNAVAILABLE_PATH, "unavailable"],
    [FEE_NETWORK_PATH, "unreachable"],
  ])("names the fee sponsor, not the signer, when the sponsor is %s", async (path) => {
    const app = buildApp();

    const res = await app.request(path, {}, baseEnv);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(body.error.message).toBe("Transaction fees can't be sponsored right now. Try again.");
    expect(body.error.message).not.toContain("signing provider");
  });

  it("names the fee sponsor when it rate limits or rejects", async () => {
    const app = buildApp();

    const limited = await app.request(FEE_RATE_LIMITED_PATH, {}, baseEnv);
    expect(limited.status).toBe(429);
    const limitedBody = (await limited.json()) as { error: { code: string; message: string } };
    expect(limitedBody.error).toEqual({
      code: "RATE_LIMITED",
      message: "The transaction fee sponsor is busy. Try again.",
    });

    const rejected = await app.request(FEE_REJECTED_PATH, {}, baseEnv);
    const rejectedBody = (await rejected.json()) as { error: { message: string } };
    expect(rejectedBody.error.message).toContain("fee sponsor rejected this transaction");
  });

  it("keeps unclassified signing failures on the retryable 502 path", async () => {
    const app = buildApp();

    const res = await app.request(FEE_AMBIGUOUS_PATH, {}, baseEnv);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("TRANSACTION_FAILED");
    expect(body.error.message).toContain("Try again");
  });

  it("redacts app error messages and details", async () => {
    const app = buildApp();

    const res = await app.request(SECRET_APP_ERROR_PATH, {}, baseEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; details: Record<string, unknown> };
    };
    expect(JSON.stringify(body)).not.toContain("privy-secret");
    expect(body.error.message).toBe("Invalid appSecret=[REDACTED]");
    expect(body.error.details).toEqual({
      appSecret: "[REDACTED]",
      tokenId: "tok_public",
    });
  });

  it("redacts RPC error messages and details", async () => {
    const app = buildApp();

    const res = await app.request(SECRET_RPC_ERROR_PATH, {}, baseEnv);

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { message: string; details: Record<string, unknown> };
    };
    expect(JSON.stringify(body)).not.toContain("rpc-secret");
    expect(body.error.message).toBe("Invalid apiKey=[REDACTED]");
    expect(body.error.details).toEqual({
      apiKey: "[REDACTED]",
      endpoint: "https://rpc.example",
    });
  });

  it("redacts payments error messages and details, and logs diagnostics it never returns", async () => {
    const loggerError = vi.spyOn(rootLogger, "error").mockImplementation(() => undefined);
    const app = buildApp();

    const res = await app.request(SECRET_PAYMENTS_ERROR_PATH, {}, baseEnv);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(JSON.stringify(body)).not.toContain("ramp-secret");
    expect(JSON.stringify(body)).not.toContain("quote service down");
    expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(body.error.message).toBe("Invalid apiKey=[REDACTED]");
    expect(body.error.details).toEqual({
      apiKey: "[REDACTED]",
      provider: "moonpay",
    });
    const logged = loggerError.mock.calls.find(
      ([payload]) =>
        typeof payload === "object" &&
        payload !== null &&
        "event" in payload &&
        payload.event === "sdp_api_payments_provider_error"
    );
    expect(logged?.[0]).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      status: 503,
      error_diagnostics: { providerMessage: "quote service down for [REDACTED_EMAIL]" },
    });
    loggerError.mockRestore();
  });

  it("uses safe signing provider messages", async () => {
    const app = buildApp();

    const res = await app.request(SECRET_SIGNING_ERROR_PATH, {}, baseEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "The signing provider is not configured. Check provider configuration and try again."
    );
    expect(JSON.stringify(body)).not.toContain("privy-secret");
  });

  it("redacts unexpected error log context", async () => {
    const consoleError = vi.spyOn(rootLogger, "error").mockImplementation(() => undefined);
    const app = buildApp();

    await app.request(SECRET_UNEXPECTED_ERROR_PATH, {}, baseEnv);

    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain("raw-private-key");
    expect(logged).not.toContain("raw-token");
    expect(logged).not.toContain("pw");
    expect(logged).toContain("[REDACTED]");
    consoleError.mockRestore();
  });

  it("scrubs counterparty PII from the unexpected-error log", async () => {
    const loggerError = vi.spyOn(rootLogger, "error").mockImplementation(() => undefined);
    const app = buildApp();

    const res = await app.request(PII_UNEXPECTED_ERROR_PATH, {}, baseEnv);

    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).not.toContain("jane.doe@example.com");
    expect(logged).not.toContain("+15551234567");
    expect(logged).not.toContain("Jane");
    expect(logged).not.toContain("1988-04-02");
    expect(logged).not.toContain("000123456789");
    expect(logged).toContain("cp_1");
    expect(logged).toContain("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("jane.doe@example.com");
    loggerError.mockRestore();
  });
});
