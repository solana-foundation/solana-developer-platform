import { describe, expect, it } from "vitest";
import { getPaymentApiError, parsePaymentApiErrorText } from "./payment-api-errors";

const FALLBACK = "Something went wrong";

describe("getPaymentApiError", () => {
  it("names the rule that denied a payment rather than only the generic message", () => {
    // The gap this closes: the custody actions joined the reason on, but the payments
    // workspace read `message` alone — and this is where people actually hit a denial.
    expect(
      getPaymentApiError(
        {
          error: {
            message: "Wallet operation denied by policy",
            details: { reason: "Destination is not on the allowlist" },
          },
        },
        FALLBACK
      )
    ).toBe("Wallet operation denied by policy — Destination is not on the allowlist");
  });

  it("leaves an ordinary error untouched", () => {
    expect(getPaymentApiError({ error: { message: "Insufficient funds" } }, FALLBACK)).toBe(
      "Insufficient funds"
    );
  });

  it("does not repeat a reason the message already states", () => {
    expect(
      getPaymentApiError(
        {
          error: { message: "Denied: asset not allowed", details: { reason: "Asset not allowed" } },
        },
        FALLBACK
      )
    ).toBe("Denied: asset not allowed");
  });

  it("still honours the string and top-level message shapes", () => {
    expect(getPaymentApiError({ error: "Rate limited" }, FALLBACK)).toBe("Rate limited");
    expect(getPaymentApiError({ message: "Gateway timeout" }, FALLBACK)).toBe("Gateway timeout");
    expect(getPaymentApiError({}, FALLBACK)).toBe(FALLBACK);
  });
});

describe("parsePaymentApiErrorText", () => {
  it("carries the denial reason through a raw body", () => {
    const body = JSON.stringify({
      error: {
        message: "Wallet operation denied by policy",
        details: { reason: "Amount exceeds the per-transfer limit" },
      },
    });

    expect(parsePaymentApiErrorText(body, FALLBACK)).toBe(
      "Wallet operation denied by policy — Amount exceeds the per-transfer limit"
    );
  });

  it("returns the body when it is not JSON", () => {
    expect(parsePaymentApiErrorText("<html>502</html>", FALLBACK)).toBe("<html>502</html>");
  });
});
