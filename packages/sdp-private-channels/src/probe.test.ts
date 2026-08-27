import { afterEach, describe, expect, it, vi } from "vitest";
import { probeConnection } from "./probe";
import { probeSolanaRpc } from "./rpc";

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : String(input);
      return impl(url, init);
    })
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GATEWAY_URL = "http://gateway.test:8899";
const CHAIN_RPC_URL = "https://api.devnet.solana.com";
const AUTH_URL = "http://auth.test:8903";

function baseInput() {
  return {
    gatewayUrl: GATEWAY_URL,
    probeRpc: () => probeSolanaRpc(CHAIN_RPC_URL),
    authUrl: AUTH_URL,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeConnection", () => {
  it("returns ok:true when gateway, RPC and auth all respond", async () => {
    stubFetch(async (url) => {
      if (url.startsWith(AUTH_URL)) return jsonResponse({ status: "ok" });
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/ready")) return jsonResponse({ status: "ready" });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "sdp-private-channels-rpc-probe",
        result: { "solana-core": "1.18.4" },
      });
    });

    const result = await probeConnection(baseInput());

    expect(result.ok).toBe(true);
    expect(result.gateway.status).toBe("ready");
    expect(result.rpc.ok).toBe(true);
    expect(result.auth.ok).toBe(true);
  });

  it("returns ok:false when gateway is ready but RPC fails", async () => {
    stubFetch(async (url) => {
      if (url.startsWith(AUTH_URL)) return jsonResponse({ status: "ok" });
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/ready")) return jsonResponse({ status: "ready" });
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: "sdp-private-channels-rpc-probe",
          error: { code: -32601, message: "Method not found" },
        },
        200
      );
    });

    const result = await probeConnection(baseInput());

    expect(result.ok).toBe(false);
    expect(result.gateway.status).toBe("ready");
    expect(result.rpc.ok).toBe(false);
    expect(result.auth.ok).toBe(true);
  });

  it("returns ok:false when gateway is unreachable even if RPC succeeds", async () => {
    stubFetch(async (url) => {
      if (url.startsWith(AUTH_URL)) return jsonResponse({ status: "ok" });
      if (url.endsWith("/health")) throw new TypeError("fetch failed");
      if (url.endsWith("/ready")) return jsonResponse({ status: "ready" });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "sdp-private-channels-rpc-probe",
        result: { "solana-core": "1.18.4" },
      });
    });

    const result = await probeConnection(baseInput());

    expect(result.ok).toBe(false);
    expect(result.gateway.status).toBe("unreachable");
    expect(result.rpc.ok).toBe(true);
    expect(result.auth.ok).toBe(true);
  });

  it("returns ok:false when the auth service returns a non-2xx", async () => {
    stubFetch(async (url) => {
      if (url.startsWith(AUTH_URL)) return jsonResponse({ status: "down" }, 503);
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/ready")) return jsonResponse({ status: "ready" });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "sdp-private-channels-rpc-probe",
        result: { "solana-core": "1.18.4" },
      });
    });

    const result = await probeConnection(baseInput());

    expect(result.ok).toBe(false);
    expect(result.gateway.status).toBe("ready");
    expect(result.rpc.ok).toBe(true);
    expect(result.auth.ok).toBe(false);
    if (!result.auth.ok) {
      expect(result.auth.error).toMatch(/HTTP 503/);
    }
  });
});
