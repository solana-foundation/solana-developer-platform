import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTrustedRampDestination,
  MOONPAY_HOSTED_APPROVED_HOSTS,
  openExternalRampUrl,
} from "./trusted-ramp-destinations";

describe("isTrustedRampDestination", () => {
  it("accepts HTTPS URLs on approved provider hosts only", () => {
    expect(
      isTrustedRampDestination("https://buy-sandbox.moonpay.com/x", MOONPAY_HOSTED_APPROVED_HOSTS)
    ).toBe(true);
    expect(
      isTrustedRampDestination("https://evil.example.net/x", MOONPAY_HOSTED_APPROVED_HOSTS)
    ).toBe(false);
    expect(
      isTrustedRampDestination("http://buy.moonpay.com/x", MOONPAY_HOSTED_APPROVED_HOSTS)
    ).toBe(false);
  });
});

describe("openExternalRampUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens plain HTTPS URLs in a new tab without an opener", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    openExternalRampUrl("https://kyc.provider.example.com/session/123");

    expect(open).toHaveBeenCalledWith(
      "https://kyc.provider.example.com/session/123",
      "_blank",
      "noopener"
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://kyc.provider.example.com/session/123",
    "//kyc.provider.example.com/session/123",
    "https://user:pass@kyc.provider.example.com/",
  ])("never opens hostile URL %s", (url) => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    openExternalRampUrl(url);

    expect(open).not.toHaveBeenCalled();
  });
});
