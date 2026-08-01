import { afterEach, describe, expect, it, vi } from "vitest";
import { probeSolanaRpc } from "./rpc";

function stubFetchOnce(response: Response | Error): void {
  const impl = () =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  vi.stubGlobal("fetch", vi.fn(impl));
}

function versionResponse(version: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "sdp-private-channels-rpc-probe",
      result: { "solana-core": version, "feature-set": 1234 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeSolanaRpc", () => {
  it("returns the solana-core version on success", async () => {
    stubFetchOnce(versionResponse("1.18.4"));

    const result = await probeSolanaRpc("https://api.devnet.solana.com");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrowing");
    expect(result.version).toBe("1.18.4");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("surfaces JSON-RPC error.message", async () => {
    stubFetchOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "sdp-private-channels-rpc-probe",
          error: { code: -32601, message: "Method not found" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await probeSolanaRpc("https://api.devnet.solana.com");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toBe("Method not found");
  });

  it("returns ok:false when HTTP status is non-2xx", async () => {
    stubFetchOnce(new Response("bad gateway", { status: 502 }));

    const result = await probeSolanaRpc("https://api.devnet.solana.com");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toContain("502");
  });

  it("returns ok:false when the fetch rejects", async () => {
    stubFetchOnce(new TypeError("fetch failed"));

    const result = await probeSolanaRpc("https://api.devnet.solana.com");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toContain("fetch failed");
  });

  it("returns ok:false when the JSON body is missing solana-core", async () => {
    stubFetchOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "sdp-private-channels-rpc-probe",
          result: { "feature-set": 1234 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await probeSolanaRpc("https://api.devnet.solana.com");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toMatch(/solana-core/);
  });

  it("rejects empty input without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeSolanaRpc("");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toMatch(/required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-http protocol without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeSolanaRpc("ftp://example.com");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toMatch(/protocol/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
