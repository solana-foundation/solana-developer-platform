import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  EgressBlockedError,
  guardedFetch,
  guardedLookup,
  headersForRedirect,
  isBlockedAddress,
  nextRedirectStep,
} from "@/services/guarded-egress";

/**
 * `assertReachableTenantEndpoint` only sees the host as written. These cover
 * the other half: what the name resolves to, checked at connect time so a
 * record that flips after validation cannot widen the boundary.
 */
describe("isBlockedAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["0.0.0.0", "this host"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.254", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "the metadata address"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link-local"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:127.0.0.1", "an IPv4-mapped loopback"],
    ["::ffff:7f00:1", "an IPv4-mapped loopback in hex"],
    ["::ffff:a9fe:a9fe", "an IPv4-mapped metadata address"],
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["172.32.0.1"],
    ["192.169.0.1"],
    ["2606:4700:4700::1111"],
    ["::ffff:8.8.8.8"],
  ])("allows the public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("guardedLookup", () => {
  it("refuses a name that resolves to a blocked address", async () => {
    // localhost is the resolvable stand-in for a tenant-controlled name whose
    // record points inward. Nothing about the URL says so.
    const error = await new Promise<Error | null>((resolve) => {
      guardedLookup("localhost", { family: 0 }, (err) => resolve(err));
    });

    expect(error).toBeInstanceOf(EgressBlockedError);
  });

  // The allow path is asserted against addresses rather than a live name on
  // purpose: a lookup of a public host would put the network in a unit test.
});

describe("nextRedirectStep", () => {
  const init = { method: "POST", body: '{"jsonrpc":"2.0"}' };

  it.each([307, 308])("repeats the request on %i", (status) => {
    expect(
      nextRedirectStep(status, "https://rpc.example/v2", "https://rpc.example/", init)
    ).toEqual({ url: "https://rpc.example/v2", method: "POST", body: '{"jsonrpc":"2.0"}' });
  });

  it.each([301, 302, 303])("downgrades to GET and drops the body on %i", (status) => {
    // What fetch did before the guard existed. Matching it keeps the change to
    // where the request is allowed to go, not what it says.
    expect(nextRedirectStep(status, "/v2", "https://rpc.example/rpc", init)).toEqual({
      url: "https://rpc.example/v2",
      method: "GET",
      body: "",
    });
  });

  it("resolves a relative location against the current URL", () => {
    expect(nextRedirectStep(308, "../v3", "https://rpc.example/a/b", init)?.url).toBe(
      "https://rpc.example/v3"
    );
  });

  it.each([200, 404, 500])("is not a redirect on %i", (status) => {
    expect(
      nextRedirectStep(status, "https://elsewhere.example/", "https://rpc.example/", init)
    ).toBeNull();
  });

  it("is not a redirect without a location", () => {
    expect(nextRedirectStep(302, null, "https://rpc.example/", init)).toBeNull();
  });
});

describe("headersForRedirect", () => {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
    Authorization: "Bearer secret",
    "x-api-key": "secret",
  };

  it("preserves provider headers within the same origin", () => {
    expect(headersForRedirect("https://rpc.example/v1", "https://rpc.example/v2", headers)).toBe(
      headers
    );
  });

  it("drops tenant credentials when a redirect changes origin", () => {
    expect(
      headersForRedirect("https://rpc.example/v1", "https://regional.example/v2", headers)
    ).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
    });
  });

  it("treats a port change as a different origin", () => {
    expect(
      headersForRedirect("https://rpc.example/v1", "https://rpc.example:8443/v2", headers)
    ).not.toHaveProperty("Authorization");
  });
});

describe("guardedFetch", () => {
  it("refuses to dial a loopback host", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "reached" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      // https so it clears the protocol gate and fails on the address instead,
      // which is the boundary under test.
      await expect(
        guardedFetch(`https://localhost:${port}/`, {
          method: "POST",
          headers: {},
          body: "{}",
        })
      ).rejects.toBeInstanceOf(EgressBlockedError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a plaintext endpoint outright", async () => {
    await expect(
      guardedFetch("http://example.com/", { method: "POST", headers: {}, body: "{}" })
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });
});
