import { describe, expect, it } from "vitest";
import {
  deliveriesPageCount,
  deliveryResultLabel,
  deliveryTone,
  formatDeliveryDuration,
  isValidWebhookEndpointUrl,
} from "./webhook-endpoints.data";

describe("isValidWebhookEndpointUrl", () => {
  it("accepts https URLs, including ports and paths", () => {
    expect(isValidWebhookEndpointUrl("https://example.com/hooks/sdp")).toBe(true);
    expect(isValidWebhookEndpointUrl("https://example.com:8443/hook?x=1")).toBe(true);
    expect(isValidWebhookEndpointUrl("  https://example.com/hook  ")).toBe(true);
  });

  it("rejects everything that isn't https (the API's rule, not the loose builder regex)", () => {
    expect(isValidWebhookEndpointUrl("http://example.com/hook")).toBe(false);
    expect(isValidWebhookEndpointUrl("ftp://example.com")).toBe(false);
    expect(isValidWebhookEndpointUrl("not-a-url")).toBe(false);
    expect(isValidWebhookEndpointUrl("")).toBe(false);
    expect(isValidWebhookEndpointUrl("https://")).toBe(false);
  });
});

describe("deliveryTone", () => {
  it("maps succeeded to success and failed to error", () => {
    expect(deliveryTone({ status: "succeeded" })).toBe("success");
    expect(deliveryTone({ status: "failed" })).toBe("error");
  });
});

describe("deliveryResultLabel", () => {
  it("prefers the HTTP status when the receiver answered", () => {
    expect(deliveryResultLabel({ responseStatus: 200, error: null, status: "succeeded" })).toBe(
      "HTTP 200"
    );
    expect(deliveryResultLabel({ responseStatus: 502, error: "HTTP_502", status: "failed" })).toBe(
      "HTTP 502"
    );
  });

  it("falls back to the failure code, then the status", () => {
    expect(
      deliveryResultLabel({
        responseStatus: null,
        error: "BLOCKED_URL:PRIVATE_HOST",
        status: "failed",
      })
    ).toBe("BLOCKED_URL:PRIVATE_HOST");
    expect(deliveryResultLabel({ responseStatus: null, error: null, status: "failed" })).toBe(
      "failed"
    );
  });
});

describe("formatDeliveryDuration", () => {
  it("renders milliseconds under a second, seconds above", () => {
    expect(formatDeliveryDuration(230)).toBe("230 ms");
    expect(formatDeliveryDuration(999)).toBe("999 ms");
    expect(formatDeliveryDuration(1_240)).toBe("1.2 s");
  });

  it("returns null for an unknown duration", () => {
    expect(formatDeliveryDuration(null)).toBeNull();
  });
});

describe("deliveriesPageCount", () => {
  it("rounds up and never returns less than one page", () => {
    expect(deliveriesPageCount(0, 25)).toBe(1);
    expect(deliveriesPageCount(25, 25)).toBe(1);
    expect(deliveriesPageCount(26, 25)).toBe(2);
    expect(deliveriesPageCount(10, 0)).toBe(1);
  });
});
