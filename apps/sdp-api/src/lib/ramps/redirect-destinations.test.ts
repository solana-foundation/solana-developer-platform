import { checkRampDestination, isTrustedRampDestination } from "@sdp/types/ramp-destinations";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { approvedRampRedirectHosts, assertApprovedRampRedirectUrl } from "./redirect-destinations";

describe("checkRampDestination", () => {
  const HOSTS = ["pay.example.com"];

  it("accepts an exact HTTPS host match", () => {
    const result = checkRampDestination("https://pay.example.com/checkout?x=1", HOSTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hostname).toBe("pay.example.com");
    }
  });

  it("matches hosts case-insensitively", () => {
    expect(isTrustedRampDestination("https://PAY.EXAMPLE.COM/checkout", HOSTS)).toBe(true);
    expect(isTrustedRampDestination("https://pay.example.com/checkout", ["PAY.Example.Com"])).toBe(
      true
    );
  });

  it.each([
    ["", "not_a_url"],
    ["   ", "not_a_url"],
    ["not a url", "not_a_url"],
    ["/relative/path", "not_a_url"],
    ["//pay.example.com/checkout", "protocol_relative"],
    ["http://pay.example.com/checkout", "insecure_scheme"],
    ["javascript:alert(1)", "insecure_scheme"],
    ["data:text/html,<script>alert(1)</script>", "insecure_scheme"],
    ["https://user:pass@pay.example.com/", "embedded_credentials"],
    ["https://evil.example.net/checkout", "host_not_approved"],
    ["https://pay.example.com.evil.example.net/", "host_not_approved"],
    ["https://sub.pay.example.com/", "host_not_approved"],
  ])("rejects %s with %s", (rawUrl, reason) => {
    const result = checkRampDestination(rawUrl, HOSTS);
    expect(result).toEqual({ ok: false, reason });
  });

  it("rejects every host when the approved list is empty (fail closed)", () => {
    expect(isTrustedRampDestination("https://pay.example.com/", [])).toBe(false);
  });

  it("keeps scheme checks when the host list is uncheckable (null)", () => {
    expect(isTrustedRampDestination("https://anywhere.example.net/kyc", null)).toBe(true);
    expect(isTrustedRampDestination("javascript:alert(1)", null)).toBe(false);
    expect(isTrustedRampDestination("//anywhere.example.net/kyc", null)).toBe(false);
  });
});

describe("assertApprovedRampRedirectUrl", () => {
  it("parses and normalizes the comma-separated allowlist", () => {
    expect(
      approvedRampRedirectHosts({
        RAMP_REDIRECT_ALLOWED_HOSTS: " App.Example.com ,, pay.example.com ",
      })
    ).toEqual(["app.example.com", "pay.example.com"]);
    expect(approvedRampRedirectHosts({})).toEqual([]);
  });

  it("accepts an approved HTTPS redirect and skips absent redirects", () => {
    const env = { RAMP_REDIRECT_ALLOWED_HOSTS: "app.example.com" };
    expect(() => assertApprovedRampRedirectUrl(env, "https://app.example.com/done")).not.toThrow();
    expect(() => assertApprovedRampRedirectUrl(env, undefined)).not.toThrow();
  });

  it("fails closed when no allowlist is configured", () => {
    expect(() => assertApprovedRampRedirectUrl({}, "https://app.example.com/done")).toThrow(
      AppError
    );
  });

  it.each([
    "http://app.example.com/done",
    "//app.example.com/done",
    "javascript:alert(1)",
    "https://evil.example.net/done",
  ])("rejects hostile redirect URL %s", (redirectUrl) => {
    expect(() =>
      assertApprovedRampRedirectUrl({ RAMP_REDIRECT_ALLOWED_HOSTS: "app.example.com" }, redirectUrl)
    ).toThrow(AppError);
  });
});
