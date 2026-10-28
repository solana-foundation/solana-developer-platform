import { describe, expect, it } from "vitest";
import {
  linkedPaymentRequestsHref,
  linkedRecurringPaymentsHref,
  PAYMENT_REQUEST_CREATED_BY_PARAMS,
  parsePaymentPrincipalParams,
  setPaymentPrincipalParams,
} from "./payment-principal-filter";

describe("parsePaymentPrincipalParams", () => {
  it.each([
    {
      name: "an API key over a member when both are named",
      params: { createdByApiKeyId: "key_test_1", createdByUserId: "user_test_1" },
      expected: { kind: "api_key", apiKeyId: "key_test_1" },
    },
    {
      name: "the first of a repeated param",
      params: { createdByApiKeyId: ["key_test_1", "key_test_2"] },
      expected: { kind: "api_key", apiKeyId: "key_test_1" },
    },
    {
      name: "the trimmed member past a blank API key",
      params: { createdByApiKeyId: "  ", createdByUserId: " user_test_1 " },
      expected: { kind: "member", userId: "user_test_1" },
    },
    {
      name: "no filter when every value is blank",
      params: { createdByApiKeyId: "", createdByUserId: " " },
      expected: null,
    },
  ])("reads $name", ({ params, expected }) => {
    expect(parsePaymentPrincipalParams(params, PAYMENT_REQUEST_CREATED_BY_PARAMS)).toEqual(
      expected
    );
  });
});

describe("setPaymentPrincipalParams", () => {
  it("replaces the filter the query held, and clears it on null, leaving other params", () => {
    const query = new URLSearchParams({ status: "paid", createdByApiKeyId: "key_test_1" });

    setPaymentPrincipalParams(
      query,
      { kind: "member", userId: "user_test_1" },
      PAYMENT_REQUEST_CREATED_BY_PARAMS
    );
    expect(query.toString()).toBe("status=paid&createdByUserId=user_test_1");

    setPaymentPrincipalParams(query, null, PAYMENT_REQUEST_CREATED_BY_PARAMS);
    expect(query.toString()).toBe("status=paid");
  });
});

describe("linked payment list hrefs", () => {
  it("narrow each list to its open rows and the principal", () => {
    expect(linkedRecurringPaymentsHref({ kind: "api_key", apiKeyId: "key_test_1" })).toBe(
      "/dashboard/payments/recurring?status=active&activatedByApiKeyId=key_test_1"
    );
    expect(linkedPaymentRequestsHref({ kind: "member", userId: "user_test_1" })).toBe(
      "/dashboard/payments/requests?status=awaiting_payment&createdByUserId=user_test_1"
    );
  });
});
