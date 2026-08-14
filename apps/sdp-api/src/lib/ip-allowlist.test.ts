import { describe, expect, it } from "vitest";
import { isClientIpAllowed, isValidIpAllowlistEntry } from "./ip-allowlist";

describe("isValidIpAllowlistEntry", () => {
  it.each([
    "203.0.113.42",
    "203.0.113.0/24",
    "0.0.0.0/0",
    "2001:db8::42",
    "2001:db8::/48",
    "::/0",
  ])("accepts a valid IP address or CIDR range: %s", (value) => {
    expect(isValidIpAllowlistEntry(value)).toBe(true);
  });

  it.each([
    "",
    "not-an-ip",
    "203.0.113.0/33",
    "2001:db8::/129",
    "203.0.113.0/not-a-prefix",
    "203.0.113.0/24/extra",
    " 203.0.113.0/24",
    "fe80::1%eth0",
  ])("rejects a malformed or ambiguous range: %s", (value) => {
    expect(isValidIpAllowlistEntry(value)).toBe(false);
  });
});

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

  it("fails closed for a missing client IP or malformed stored configuration", () => {
    expect(isClientIpAllowed(null, ["203.0.113.0/24"])).toBe(false);
    expect(isClientIpAllowed("203.0.113.42", ["not-an-ip"])).toBe(false);
    expect(isClientIpAllowed("203.0.113.42", "203.0.113.0/24")).toBe(false);
  });
});
