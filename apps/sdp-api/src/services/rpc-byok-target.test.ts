// Lives in sdp-api rather than sdp-rpc: the package carries no test runner,
// and this is the code path the RPC connection service depends on.

import {
  assertReachableTenantEndpoint,
  BYOK_RPC_PROVIDERS,
  buildTenantDisplayMetadata,
  buildTenantRpcTarget,
  isByokRpcProvider,
  maskTenantEndpoint,
} from "@sdp/rpc/byok";
import { describe, expect, it } from "vitest";

const KEY = "tenant-secret-key-1234";

describe("buildTenantRpcTarget", () => {
  it("puts a Helius key in the query string", () => {
    const target = buildTenantRpcTarget("helius", {
      endpointUrl: "https://devnet.helius-rpc.com",
      apiKey: KEY,
    });
    expect(target.endpoint).toContain(`api-key=${encodeURIComponent(KEY)}`);
    expect(target.headers).toEqual({});
  });

  it("puts an Alchemy key in the path segment", () => {
    const target = buildTenantRpcTarget("alchemy", {
      endpointUrl: "https://solana-devnet.g.alchemy.com/v2",
      apiKey: KEY,
    });
    expect(target.endpoint).toBe(
      `https://solana-devnet.g.alchemy.com/v2/${encodeURIComponent(KEY)}`
    );
  });

  it("sends a Triton key as a header and never in the query string", () => {
    const target = buildTenantRpcTarget("triton", {
      endpointUrl: "https://tenant.rpcpool.com",
      apiKey: KEY,
    });
    expect(target.headers).toEqual({ "x-api-key": KEY });
    // A key in the URL would survive into any log that records the endpoint.
    expect(new URL(target.endpoint).search).toBe("");
  });

  it("honours the {API_KEY} placeholder the platform already uses", () => {
    const target = buildTenantRpcTarget("quicknode", {
      endpointUrl: "https://example.quiknode.pro/{API_KEY}/",
      apiKey: KEY,
    });
    expect(target.endpoint).toBe(`https://example.quiknode.pro/${encodeURIComponent(KEY)}/`);
  });

  it("refuses an empty endpoint or key rather than building a broken target", () => {
    expect(() => buildTenantRpcTarget("helius", { endpointUrl: "  ", apiKey: KEY })).toThrow(
      /endpoint URL/
    );
    expect(() =>
      buildTenantRpcTarget("helius", { endpointUrl: "https://x.example", apiKey: "   " })
    ).toThrow(/API key/);
  });

  it("covers every BYOK provider", () => {
    for (const provider of BYOK_RPC_PROVIDERS) {
      const target = buildTenantRpcTarget(provider, {
        endpointUrl: "https://tenant.example/rpc",
        apiKey: KEY,
      });
      expect(target.endpoint).toMatch(/^https:\/\//);
    }
  });

  it("does not treat SDP's own rail as a tenant provider", () => {
    expect(isByokRpcProvider("default")).toBe(false);
    expect(isByokRpcProvider("helius")).toBe(true);
  });
});

describe("tenant redaction", () => {
  it("masks the tenant key wherever it landed", () => {
    const target = buildTenantRpcTarget("helius", {
      endpointUrl: "https://devnet.helius-rpc.com",
      apiKey: KEY,
    });
    const masked = maskTenantEndpoint(target.endpoint, KEY);
    expect(masked).not.toContain(KEY);
    expect(masked).not.toContain(encodeURIComponent(KEY));
  });

  it("keeps only a host and a short suffix for display", () => {
    const metadata = buildTenantDisplayMetadata({
      endpointUrl: "https://tenant.example/rpc",
      apiKey: KEY,
    });
    expect(metadata).toEqual({ endpointHost: "tenant.example", apiKeySuffix: "1234" });
    expect(JSON.stringify(metadata)).not.toContain(KEY);
  });

  it("omits a suffix for a key too short to disambiguate safely", () => {
    expect(buildTenantDisplayMetadata({ endpointUrl: "https://a.example", apiKey: "abc" })).toEqual(
      {
        endpointHost: "a.example",
      }
    );
  });
});

describe("assertReachableTenantEndpoint", () => {
  it("refuses the cloud metadata address", () => {
    // The endpoint is fetched on activation and on every relayed request, so a
    // stored metadata URL would turn SDP's server into the caller.
    expect(() => assertReachableTenantEndpoint("https://169.254.169.254/latest/meta-data")).toThrow(
      /not reachable/i
    );
  });

  it("refuses loopback and private ranges", () => {
    for (const host of [
      "https://localhost/rpc",
      "https://127.0.0.1/rpc",
      "https://10.0.0.5/rpc",
      "https://192.168.1.10/rpc",
      "https://172.16.4.4/rpc",
      "https://vault.internal/rpc",
    ]) {
      expect(() => assertReachableTenantEndpoint(host)).toThrow(/not reachable/i);
    }
  });

  it("refuses IPv6 loopback, unique-local and link-local literals", () => {
    // `URL.hostname` keeps the brackets on an IPv6 literal, so a blocklist that
    // anchors on the address itself has to strip them first. These are the
    // cases that got through when it did not.
    for (const host of [
      "https://[::1]/rpc",
      "https://[0:0:0:0:0:0:0:1]/rpc",
      "https://[::]/rpc",
      "https://[fd00::1]/rpc",
      "https://[fc00::1]/rpc",
      "https://[fe80::1]/rpc",
      "https://[fe80::a00:27ff:fe4e:66a1]/rpc",
      // The IPv6 form of the metadata endpoint.
      "https://[fe80::a9fe:a9fe]/rpc",
    ]) {
      expect(() => assertReachableTenantEndpoint(host)).toThrow(/not reachable/i);
    }
  });

  it("refuses an IPv4-mapped private address the parser rewrites to hex", () => {
    // `new URL("https://[::ffff:127.0.0.1]/")` reports `[::ffff:7f00:1]`, which
    // no dotted-quad pattern can match. Loopback must not re-enter that way.
    expect(() => assertReachableTenantEndpoint("https://[::ffff:127.0.0.1]/rpc")).toThrow(
      /not reachable/i
    );
    expect(() => assertReachableTenantEndpoint("https://[::ffff:169.254.169.254]/rpc")).toThrow(
      /not reachable/i
    );
  });

  it("still allows a routable IPv6 endpoint", () => {
    // The blocklist is about private reachability, not about IPv6.
    expect(() => assertReachableTenantEndpoint("https://[2606:4700::1111]/rpc")).not.toThrow();
  });

  it("refuses plaintext http", () => {
    expect(() => assertReachableTenantEndpoint("http://rpc.example.com")).toThrow(/https/i);
  });

  it("refuses a malformed URL", () => {
    expect(() => assertReachableTenantEndpoint("not-a-url")).toThrow(/valid URL/i);
  });

  it("allows an ordinary vendor endpoint", () => {
    expect(() => assertReachableTenantEndpoint("https://devnet.helius-rpc.com")).not.toThrow();
    expect(() => assertReachableTenantEndpoint("https://example.quiknode.pro/abc/")).not.toThrow();
  });
});
