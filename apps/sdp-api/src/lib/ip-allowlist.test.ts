import { canonicalizeIpRange } from "@sdp/ip/ip-range";
import { describe, expect, it } from "vitest";
import { isClientIpAllowed } from "./ip-allowlist";

describe("isClientIpAllowed", () => {
  it("matches IPv4 addresses and CIDR ranges", () => {
    expect(isClientIpAllowed("203.0.113.42", ["203.0.113.42"])).toBe(true);
    expect(isClientIpAllowed("203.0.113.42", ["203.0.113.0/24"])).toBe(true);
    expect(isClientIpAllowed("203.0.114.42", ["203.0.113.0/24"])).toBe(false);
  });

  it("matches IPv6 addresses and CIDR ranges", () => {
    expect(isClientIpAllowed("2001:db8::42", ["2001:db8::42"])).toBe(true);
    expect(isClientIpAllowed("2001:db8:1::42", ["2001:db8:1::/48"])).toBe(true);
    expect(isClientIpAllowed("2001:db8:2::42", ["2001:db8:1::/48"])).toBe(false);
  });

  it("matches an IPv4-mapped IPv6 client against an IPv4 range", () => {
    expect(isClientIpAllowed("::ffff:203.0.113.42", ["203.0.113.0/24"])).toBe(true);
  });

  it("preserves unrestricted keys", () => {
    expect(isClientIpAllowed(null, null)).toBe(true);
    expect(isClientIpAllowed(null, [])).toBe(true);
  });

  it("matches the range a canonicalized entry names", () => {
    const canonical = canonicalizeIpRange("203.0.113.5/24");
    expect(isClientIpAllowed("203.0.113.42", [canonical])).toBe(true);
    expect(isClientIpAllowed("203.0.114.42", [canonical])).toBe(false);
  });

  it("fails closed for a missing client IP or malformed stored configuration", () => {
    expect(isClientIpAllowed(null, ["203.0.113.0/24"])).toBe(false);
    expect(isClientIpAllowed("203.0.113.42", ["not-an-ip"])).toBe(false);
    expect(isClientIpAllowed("203.0.113.42", "203.0.113.0/24")).toBe(false);
  });
});
