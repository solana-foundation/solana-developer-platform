// Lives in sdp-api rather than sdp-rpc: the package carries no test runner,
// and this is the code path the RPC connection service depends on.

import {
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
