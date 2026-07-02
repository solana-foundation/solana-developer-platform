import { describe, expect, it } from "vitest";
import { ipMatchesAllowedIps, isValidIpAllowlistEntry } from "./ip-allowlist";

describe("IP allowlist matching", () => {
  it("allows requests when no allowlist is configured", () => {
    expect(ipMatchesAllowedIps(null, null)).toBe(true);
    expect(ipMatchesAllowedIps("203.0.113.42", [])).toBe(true);
  });

  it("matches exact IPv4 entries and IPv4 CIDR ranges", () => {
    expect(ipMatchesAllowedIps("203.0.113.42", ["203.0.113.42"])).toBe(true);
    expect(ipMatchesAllowedIps("203.0.113.42", ["203.0.113.0/24"])).toBe(true);
    expect(ipMatchesAllowedIps("203.0.114.42", ["203.0.113.0/24"])).toBe(false);
  });

  it("matches IPv4-mapped IPv6 request IPs against IPv4 entries", () => {
    expect(ipMatchesAllowedIps("::ffff:203.0.113.42", ["203.0.113.42"])).toBe(true);
    expect(ipMatchesAllowedIps("::ffff:203.0.113.42", ["203.0.113.0/24"])).toBe(true);
  });

  it("matches exact IPv6 entries and IPv6 CIDR ranges", () => {
    expect(ipMatchesAllowedIps("2001:db8::42", ["2001:db8::42"])).toBe(true);
    expect(ipMatchesAllowedIps("2001:db8::42", ["2001:db8::/32"])).toBe(true);
    expect(ipMatchesAllowedIps("2001:db9::42", ["2001:db8::/32"])).toBe(false);
  });

  it("denies requests without a parseable source IP when an allowlist exists", () => {
    expect(ipMatchesAllowedIps(null, ["203.0.113.0/24"])).toBe(false);
    expect(ipMatchesAllowedIps("not-an-ip", ["203.0.113.0/24"])).toBe(false);
  });

  it("denies malformed allowlists even when another entry would match", () => {
    expect(ipMatchesAllowedIps("203.0.113.42", ["203.0.113.0/24", "not-a-cidr"])).toBe(false);
  });

  it("denies non-array allowlist data", () => {
    expect(ipMatchesAllowedIps("203.0.113.42", "203.0.113.42")).toBe(false);
  });

  it("validates allowlist entry syntax", () => {
    expect(isValidIpAllowlistEntry("203.0.113.42")).toBe(true);
    expect(isValidIpAllowlistEntry("203.0.113.0/24")).toBe(true);
    expect(isValidIpAllowlistEntry("2001:db8::/32")).toBe(true);
    expect(isValidIpAllowlistEntry("203.0.113.0/33")).toBe(false);
    expect(isValidIpAllowlistEntry("2001:db8::/129")).toBe(false);
    expect(isValidIpAllowlistEntry("not-a-cidr")).toBe(false);
  });
});
