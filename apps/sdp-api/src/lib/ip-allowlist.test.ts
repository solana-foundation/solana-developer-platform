import { describe, expect, it } from "vitest";
import {
  canonicalizeIpAllowlistEntry,
  isClientIpAllowed,
  isValidIpAllowlistEntry,
} from "./ip-allowlist";

describe("isValidIpAllowlistEntry", () => {
  it.each(["203.0.113.42", "203.0.113.0/24", "0.0.0.0/0", "2001:db8::42", "2001:db8::/48", "::/0"])(
    "accepts a valid IP address or CIDR range: %s",
    (value) => {
      expect(isValidIpAllowlistEntry(value)).toBe(true);
    }
  );

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

describe("canonicalizeIpAllowlistEntry", () => {
  it.each([
    // Host bits are cleared, so the stored range names what it selects rather
    // than one of the addresses inside it.
    ["203.0.113.5/24", "203.0.113.0/24"],
    ["203.0.113.5/32", "203.0.113.5"],
    ["203.0.113.5", "203.0.113.5"],
    ["10.11.12.13/8", "10.0.0.0/8"],
    ["203.0.113.5/0", "0.0.0.0/0"],
    // RFC 5952 form: lowercase, no leading zeros, longest zero run elided.
    ["2001:0DB8:0000:0000:0000:0000:0000:0042", "2001:db8::42"],
    ["2001:db8:1:0:0:0:0:0/48", "2001:db8:1::/48"],
    ["2001:db8::42/64", "2001:db8::/64"],
    ["::", "::"],
    ["::/0", "::/0"],
    // A single zero group is written out; `::` stands for two or more.
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    // An IPv4-mapped range authorizes IPv4 clients, so it is stored as the IPv4
    // range it actually is.
    ["::ffff:203.0.113.42", "203.0.113.42"],
    ["::ffff:203.0.113.5/120", "203.0.113.0/24"],
    // Below /96 the prefix cuts into the mapping prefix, so the range is no
    // longer confined to the IPv4 space and stays in IPv6 form.
    ["::ffff:203.0.113.5/95", "::fffe:0:0/95"],
  ])("rewrites %s as %s", (value, expected) => {
    expect(canonicalizeIpAllowlistEntry(value)).toBe(expected);
  });

  it.each(["", "not-an-ip", "203.0.113.0/33", " 203.0.113.0/24", "fe80::1%eth0", "010.0.0.1"])(
    "returns null for an entry that is not a valid range: %s",
    (value) => {
      expect(canonicalizeIpAllowlistEntry(value)).toBeNull();
    }
  );

  it("agrees with isValidIpAllowlistEntry on what it accepts", () => {
    for (const value of ["203.0.113.0/24", "2001:db8::/48", "::", "not-an-ip", "203.0.113.0/33"]) {
      expect(canonicalizeIpAllowlistEntry(value) !== null).toBe(isValidIpAllowlistEntry(value));
    }
  });

  it("preserves the range a canonicalized entry matches", () => {
    const canonical = canonicalizeIpAllowlistEntry("203.0.113.5/24") as string;
    expect(isClientIpAllowed("203.0.113.42", [canonical])).toBe(true);
    expect(isClientIpAllowed("203.0.114.42", [canonical])).toBe(false);
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
