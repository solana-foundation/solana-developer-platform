import { describe, expect, it } from "vitest";
import { getPaymentApiError, parsePaymentApiErrorText } from "./payment-api-errors";

const FALLBACK = "Something went wrong";

describe("getPaymentApiError", () => {
  it("leaves an ordinary error untouched", () => {
    expect(getPaymentApiError({ error: { message: "Insufficient funds" } }, FALLBACK)).toBe(
      "Insufficient funds"
    );
  });

  it("still honours the string and top-level message shapes", () => {
    expect(getPaymentApiError({ error: "Rate limited" }, FALLBACK)).toBe("Rate limited");
    expect(getPaymentApiError({ message: "Gateway timeout" }, FALLBACK)).toBe("Gateway timeout");
    expect(getPaymentApiError({}, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for malformed error envelopes and ignores malformed details", () => {
    expect(getPaymentApiError(null, FALLBACK)).toBe(FALLBACK);
    expect(getPaymentApiError({ error: null }, FALLBACK)).toBe(FALLBACK);
    expect(
      getPaymentApiError({ error: { message: "Denied", details: "wrong shape" } }, FALLBACK)
    ).toBe("Denied");
  });
});

describe("parsePaymentApiErrorText", () => {
  it("reads the message from a raw JSON body", () => {
    const body = JSON.stringify({ error: { message: "Insufficient funds" } });

    expect(parsePaymentApiErrorText(body, FALLBACK)).toBe("Insufficient funds");
  });

  it("returns the body when it is not JSON", () => {
    expect(parsePaymentApiErrorText("<html>502</html>", FALLBACK)).toBe("<html>502</html>");
  });
});
