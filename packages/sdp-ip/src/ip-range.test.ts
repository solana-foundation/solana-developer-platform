import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizeIpRange, isValidIpRange } from "./ip-range";

describe("isValidIpRange", () => {
  it("accepts a valid IP address or CIDR range", () => {
    for (const value of [
      "203.0.113.42",
      "203.0.113.0/24",
      "0.0.0.0/0",
      "2001:db8::42",
      "2001:db8::/48",
      "::/0",
    ]) {
      assert.equal(isValidIpRange(value), true, value);
    }
  });

  it("rejects a malformed or ambiguous range", () => {
    for (const value of [
      "",
      "not-an-ip",
      "203.0.113.0/33",
      "2001:db8::/129",
      "203.0.113.0/not-a-prefix",
      "203.0.113.0/24/extra",
      " 203.0.113.0/24",
      "fe80::1%eth0",
    ]) {
      assert.equal(isValidIpRange(value), false, value);
    }
  });
});

describe("canonicalizeIpRange", () => {
  it("rewrites each range in canonical form", () => {
    for (const [value, expected] of [
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
    ]) {
      assert.equal(canonicalizeIpRange(value), expected, value);
    }
  });

  it("returns null for an entry that is not a valid range", () => {
    for (const value of [
      "",
      "not-an-ip",
      "203.0.113.0/33",
      " 203.0.113.0/24",
      "fe80::1%eth0",
      "010.0.0.1",
    ]) {
      assert.equal(canonicalizeIpRange(value), null, value);
    }
  });

  it("agrees with isValidIpRange on what it accepts", () => {
    for (const value of ["203.0.113.0/24", "2001:db8::/48", "::", "not-an-ip", "203.0.113.0/33"]) {
      assert.equal(canonicalizeIpRange(value) !== null, isValidIpRange(value), value);
    }
  });
});
