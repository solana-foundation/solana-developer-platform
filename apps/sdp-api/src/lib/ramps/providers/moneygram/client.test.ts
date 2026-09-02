import {
  MoneygramRampClient,
  moneygramSessionExpiry,
} from "@sdp/payments/ramps/providers/moneygram/client";
import type { RampOnrampQuoteInput, RampRuntimeContext } from "@sdp/payments/ramps/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const MONEYGRAM_CONTEXT: RampRuntimeContext = {
  env: { MONEYGRAM_SANDBOX_SECRET_KEY: "moneygram_secret" },
  mode: "sandbox",
};

const ONRAMP_INPUT: RampOnrampQuoteInput = {
  cryptoToken: "USDC",
  fiatCurrency: "USD",
  fiatAmount: "25",
  destinationWalletAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  externalCustomerId: "counterparty_123",
};

function sessionJwt(exp?: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(exp === undefined ? {} : { exp })}.sig`;
}

function sessionResponse(
  overrides: Partial<Record<"sessionToken" | "sessionId" | "widgetUrl", string>>
): Response {
  return new Response(
    JSON.stringify({
      sessionToken: sessionJwt(1789000000),
      sessionId: "moneygram_session_123",
      widgetUrl: "https://playground.xramps.moneygram.com/widget?mode=off-ramp",
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("MoneygramRampClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a session quote bound to the session JWT expiry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sessionResponse({}));

    const quote = await new MoneygramRampClient().createOnrampQuote(
      MONEYGRAM_CONTEXT,
      ONRAMP_INPUT
    );

    expect(quote.provider).toBe("moneygram");
    if (quote.provider !== "moneygram") {
      throw new Error("Expected MoneyGram quote");
    }
    expect(quote.sessionId).toBe("moneygram_session_123");
    const widgetUrl = new URL(quote.widgetUrl);
    expect(widgetUrl.origin).toBe("https://playground.xramps.moneygram.com");
    expect(widgetUrl.searchParams.get("mode")).toBe("on-ramp");
    expect(quote.expiresAt).toBe(new Date(1789000000 * 1000).toISOString());
  });

  it("falls back to a 1h expiry when the session JWT has no exp claim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      sessionResponse({ sessionToken: sessionJwt() })
    );
    const before = Date.now();

    const quote = await new MoneygramRampClient().createOnrampQuote(
      MONEYGRAM_CONTEXT,
      ONRAMP_INPUT
    );

    if (quote.provider !== "moneygram" || !quote.expiresAt) {
      throw new Error("Expected MoneyGram quote with expiry");
    }
    const expiryMs = Date.parse(quote.expiresAt);
    expect(expiryMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(expiryMs).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it.each([
    ["http://playground.xramps.moneygram.com/widget", "insecure scheme"],
    ["//playground.xramps.moneygram.com/widget", "protocol-relative"],
    ["javascript:alert(1)", "active content"],
    ["data:text/html,<script>alert(1)</script>", "data URL"],
    ["https://evil.example.com/widget", "unapproved host"],
    ["https://playground.xramps.moneygram.com.evil.example/widget", "host suffix spoof"],
    ["https://user:pass@playground.xramps.moneygram.com/widget", "embedded credentials"],
  ])("fails closed on an untrusted widget URL (%s — %s)", async (widgetUrl) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sessionResponse({ widgetUrl }));

    await expect(
      new MoneygramRampClient().createOnrampQuote(MONEYGRAM_CONTEXT, ONRAMP_INPUT)
    ).rejects.toThrow(/untrusted widget URL/);
  });
});

describe("moneygramSessionExpiry", () => {
  it("reads the exp claim from a base64url JWT payload", () => {
    expect(moneygramSessionExpiry(sessionJwt(1789000000))).toBe(
      new Date(1789000000 * 1000).toISOString()
    );
  });

  it("falls back to now + 1h for malformed tokens", () => {
    const now = 1_750_000_000_000;
    const fallback = new Date(now + 60 * 60 * 1000).toISOString();
    expect(moneygramSessionExpiry("not-a-jwt", now)).toBe(fallback);
    expect(moneygramSessionExpiry("a.%%%.c", now)).toBe(fallback);
    expect(moneygramSessionExpiry(sessionJwt(Number.NaN), now)).toBe(fallback);
  });
});
